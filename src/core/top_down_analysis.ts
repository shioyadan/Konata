/**
 * ParsedTraceからTop-down-likeのslot分類を構築する。UIやCanvasには依存しない。
 *
 * 解析は次の順で行う。
 *
 * 1. StageStructureDetectorでallocation周辺の構造、観測幅、通常latencyを推定する。
 * 2. 検出済みの構造を使い、各cycleのslotを6種類へ分類する。
 * 3. 表示範囲をsamplingし、分類ごとのslot数を集計する。
 *
 * 結果は1 byte／slotで保持し、表示範囲のsamplingと集計は最後に行う。
 */
import {
    type DetectedStage,
    type DetectedStageStructure,
    StageStructureDetector,
} from "./stage_structure_detector";
import type { Op, ParsedTrace } from "./model";

const DEFAULT_YIELD_INTERVAL = 50_000;
export const TOP_DOWN_INITIAL_SNAPSHOT_OP_COUNT = 50_000;
// 全slotを保持しても解析中のTypedArrayが大きくなり過ぎないよう、従来のcycle上限に
// 加えてallocation幅を含むworking setにも上限を設ける。
const MAX_EXACT_TOP_DOWN_CYCLE_COUNT = 4 * 1024 * 1024;
const MAX_TOP_DOWN_WORKING_BYTES = 128 * 1024 * 1024;
// 1件だけの短い外れ値をpipeline固有の最短回復時間としない。通常の分岐回復なら
// 同じcycle数が繰り返し現れるため、十分な反復を持つ最小bucketだけを採用する。
const MIN_SUPPORTED_RECOVERY_SAMPLE_COUNT = 10;

const enum TopDownSlotClass {
    // allocation済みのslotは命令の最終状態、空slotは供給されなかった原因を表す。
    RETIRING,       // allocationされ、正常にretireした命令
    SQUASHED,       // allocationされたが、後にflushされた命令
    RECOVERY_BUBBLE, // flush原因の解決後、正しい命令を再供給するまでの空き
    FRONTEND_BOUND, // allocation入口まで命令が届かなかった空き
    BACKEND_BOUND,  // allocation入口のbackpressureで生じた空き
    UNRESOLVED,     // allocation済みだが、retire／flushがまだ未確定の命令
}

function yieldToBrowser(): Promise<void> {
    return new Promise<void>((resolve) => {
        const channel = new MessageChannel();
        channel.port1.onmessage = () => {
            channel.port1.close();
            channel.port2.close();
            resolve();
        };
        channel.port2.postMessage(undefined);
    });
}

export interface TopDownStage {
    readonly laneID: number;
    readonly stageName: string;
    readonly label: string;
}

export interface TopDownAnalysis {
    readonly allocationStage: TopDownStage;
    readonly executionStage: TopDownStage;
    readonly completionStages: readonly TopDownStage[];
    readonly allocationWidth: number;
    readonly transitionCoverage: number;
    readonly admissionStages: readonly TopDownAdmission[];
    readonly recoveryWindowCount: number;
    readonly minimumRecoveryCycles: number | null;
    readonly minimumRecoverySampleCount: number;
    // cycle * allocationWidth + slotをindexとする、全cycleの分類結果。
    readonly slots: Uint8Array;
}

export interface TopDownAdmission {
    readonly stage: TopDownStage;
    readonly typicalLatency: number;
}

export interface TopDownData {
    readonly cycleCount: number;
    readonly sourceLastID: number;
    readonly analysis: TopDownAnalysis | null;
}

export interface TopDownBreakdown {
    readonly analysis: TopDownAnalysis;
    readonly startCycle: number;
    readonly endCycle: number;
    readonly totalSlots: number;
    readonly retiringSlots: number;
    readonly squashedSlots: number;
    readonly recoveryBubbleSlots: number;
    readonly unresolvedSlots: number;
    readonly frontendBound: number;
    readonly backendBound: number;
    readonly sampledCycleCount: number;
    readonly samplingStride: number;
}

export interface TopDownBuildOptions {
    readonly yieldInterval?: number;
    readonly isCanceled?: () => boolean;
    readonly live?: boolean;
}

type StageLabels = ReadonlyMap<number, ReadonlyMap<string, string>>;

interface StageAnalysisReference {
    readonly allocationStage: TopDownStage;
    readonly executionStage: TopDownStage;
    readonly completionStages: readonly TopDownStage[];
    readonly allocationWidth: number;
    readonly transitionCoverage: number;
    readonly admissionStages: readonly TopDownAdmission[];
}

function createStageLabels(trace: ParsedTrace): StageLabels {
    // 構造はDetectorが確定済みなので、ここではUIへ渡す表示名だけを作る。
    const labels = new Map<number, Map<string, string>>();
    const showLaneName = trace.stageLevelMap.laneNum > 1;
    for (const laneName of trace.stageLevelMap.laneNames) {
        const laneID = trace.stageLevelMap.getLaneID(laneName);
        if (laneID === undefined) {
            continue;
        }
        const laneLabels = new Map<string, string>();
        labels.set(laneID, laneLabels);
        for (const stageName of trace.stageLevelMap.getStageNames(laneName)) {
            laneLabels.set(stageName, showLaneName ? `${laneName}/${stageName}` : stageName);
        }
    }
    return labels;
}

function resolveStage(
    stage: Readonly<DetectedStage>,
    labels: StageLabels,
): TopDownStage | null {
    const label = labels.get(stage.laneID)?.get(stage.stageName);
    return label === undefined ? null : { ...stage, label };
}

function resolveStageStructure(
    structure: Readonly<DetectedStageStructure>,
    labels: StageLabels,
): StageAnalysisReference | null {
    const allocationStage = resolveStage(structure.allocationStage, labels);
    const executionStage = resolveStage(structure.executionStage, labels);
    if (allocationStage === null || executionStage === null) {
        return null;
    }
    const admissionStages: TopDownAdmission[] = [];
    for (const admission of structure.admissionStages) {
        const stage = resolveStage(admission, labels);
        if (stage !== null) {
            admissionStages.push({ stage, typicalLatency: admission.typicalLatency });
        }
    }
    const completionStages: TopDownStage[] = [];
    for (const detected of structure.completionStages) {
        const stage = resolveStage(detected, labels);
        if (stage !== null && stage.laneID === executionStage.laneID) {
            completionStages.push(stage);
        }
    }
    return {
        allocationStage,
        executionStage,
        completionStages,
        allocationWidth: structure.allocationStage.width,
        transitionCoverage: structure.transitionCoverage,
        admissionStages,
    };
}

function isLikelyControlFlowLabel(labelName: string): boolean {
    // flush列の直前という動的な関係を主な根拠にし、labelはbranch／jump以外のclearを
    // 誤って結び付けないためのgateにだけ使う。x86 gem5は最終micro-opのwripを要求する。
    const separator = labelName.indexOf(":");
    const disassembly = (separator < 0 ? labelName : labelName.slice(separator + 1)).trim();
    const mnemonic = (disassembly.split(/\s+/, 1)[0] ?? "").toLowerCase();
    if (/\bwrip\b/i.test(disassembly)) {
        return /^(?:j|call|ret)/.test(mnemonic);
    }
    const uncompressed = mnemonic.replace(/^c[._]/, "");
    return /^(?:j|jr|jal|jalr|call|ret)$/.test(uncompressed) ||
        /^(?:b|bl|blr|br|bx|bal|beq|bne|beqz|bnez|blt|bge|bltu|bgeu|bgez|bltz|blez|bgtz|cbz|cbnz|tbz|tbnz)(?:\..*)?$/.test(uncompressed);
}

function getSupportedMinimum(
    histogram: ReadonlyMap<number, number>,
): { readonly value: number; readonly sampleCount: number } | null {
    let supported: { readonly value: number; readonly sampleCount: number } | null = null;
    for (const [latency, sampleCount] of histogram) {
        if (sampleCount >= MIN_SUPPORTED_RECOVERY_SAMPLE_COUNT &&
            (supported === null || latency < supported.value)) {
            supported = { value: latency, sampleCount };
        }
    }
    return supported;
}

function isAllocatedSlot(slotClass: TopDownSlotClass): boolean {
    return slotClass === TopDownSlotClass.RETIRING ||
        slotClass === TopDownSlotClass.SQUASHED ||
        slotClass === TopDownSlotClass.UNRESOLVED;
}

function addAllocatedSlot(
    slots: Uint8Array,
    allocationWidth: number,
    cycle: number,
    slotClass: TopDownSlotClass,
): void {
    // 同じcycleの左から空slotを探す。観測幅を超えた命令は表示枠へ追加できない。
    const firstSlot = Math.floor(cycle) * allocationWidth;
    const endSlot = firstSlot + allocationWidth;
    if (firstSlot < 0 || endSlot > slots.length) {
        return;
    }
    for (let index = firstSlot; index < endSlot; index++) {
        if (!isAllocatedSlot(slots[index] as TopDownSlotClass)) {
            slots[index] = slotClass;
            return;
        }
    }
}

function markEmptySlots(
    slots: Uint8Array,
    allocationWidth: number,
    startCycle: number,
    endCycle: number,
    slotClass: TopDownSlotClass,
): void {
    // 命令が使用済みのslotは上書きしない。BackendはFrontendだけを置換し、先に
    // 確定したRecovery bubbleをlive更新で壊さない。
    const capacity = Math.floor(slots.length / allocationWidth);
    const firstCycle = Math.max(0, Math.min(capacity, Math.floor(startCycle)));
    const lastCycle = Math.max(firstCycle, Math.min(capacity, Math.ceil(endCycle)));
    for (let cycle = firstCycle; cycle < lastCycle; cycle++) {
        const firstSlot = cycle * allocationWidth;
        const endSlot = firstSlot + allocationWidth;
        for (let index = firstSlot; index < endSlot; index++) {
            const current = slots[index] as TopDownSlotClass;
            if (!isAllocatedSlot(current) &&
                (slotClass !== TopDownSlotClass.BACKEND_BOUND ||
                    current === TopDownSlotClass.FRONTEND_BOUND)) {
                slots[index] = slotClass;
            }
        }
    }
}

function markCycleRange(
    cycles: Uint8Array,
    startCycle: number,
    endCycle: number,
    slotClass: TopDownSlotClass,
): void {
    // slot配列とは別に、cycleごとの空slot分類を記録する。
    const start = Math.max(0, Math.min(cycles.length, Math.floor(startCycle)));
    const end = Math.max(start, Math.min(cycles.length, Math.ceil(endCycle)));
    cycles.fill(slotClass, start, end);
}

function getOpSlotClass(op: Readonly<Op>): TopDownSlotClass {
    // allocationされた命令は最終状態だけで分類し、後段での待ち時間はslot数へ足さない。
    return op.retired
        ? TopDownSlotClass.RETIRING
        : op.flush
            ? TopDownSlotClass.SQUASHED
            : TopDownSlotClass.UNRESOLVED;
}

interface AllocationStageObservation {
    readonly firstAllocationCycle: number | null;
    readonly completionCycle: number | null;
}

interface AdmissionLatency {
    readonly typicalLatency: number;
}

function observeAllocationStages(
    op: Readonly<Op>,
    laneID: number,
    allocationStageName: string,
    executionStageName: string,
    completionStageNames: ReadonlySet<string>,
    admissions: ReadonlyMap<string, Readonly<AdmissionLatency>>,
    onAdmissionStall: (startCycle: number, endCycle: number) => void,
): AllocationStageObservation {
    // 一命令のstage列からallocation時刻、completion proxy、入口停滞を同時に得る。
    // 同名stageの連続区間は一つの滞留として扱う。
    const lane = op.lanes[laneID];
    let firstAllocationCycle: number | null = null;
    let completionCycle: number | null = null;
    if (lane === null || lane === undefined) {
        return { firstAllocationCycle, completionCycle };
    }

    let previousStageName: string | null = null;
    let previousStageStart = 0;
    let previousStageEnd = 0;
    let executionSeen = false;
    for (const stage of lane.stages) {
        const endCycle = stage.endCycle === 0 ? op.retiredCycle : stage.endCycle;
        if (stage.name !== previousStageName) {
            const admission = previousStageName === null
                ? undefined
                : admissions.get(previousStageName);
            if (stage.name === allocationStageName && admission !== undefined) {
                onAdmissionStall(
                    previousStageStart + admission.typicalLatency,
                    Math.min(previousStageEnd, stage.startCycle),
                );
            }
            previousStageName = stage.name;
            previousStageStart = stage.startCycle;
            previousStageEnd = endCycle;
        } else {
            previousStageEnd = Math.max(previousStageEnd, endCycle);
        }
        if (stage.name === allocationStageName) {
            firstAllocationCycle = firstAllocationCycle === null
                ? stage.startCycle
                : Math.min(firstAllocationCycle, stage.startCycle);
        }
        if (stage.name === executionStageName) {
            executionSeen = true;
        } else if (executionSeen && completionCycle === null) {
            // Detectorが見つけたexecution直後段だけをComplete proxyとして使う。
            completionCycle = completionStageNames.has(stage.name) ? stage.startCycle : null;
            executionSeen = false;
        }
    }
    return { firstAllocationCycle, completionCycle };
}

async function classifyTopDownSlots(
    trace: ParsedTrace,
    reference: Readonly<StageAnalysisReference>,
    cycleCount: number,
    lastID: number,
    yieldInterval: number,
    isCanceled?: () => boolean,
): Promise<TopDownAnalysis | null> {
    // 未使用slotの既定値はFrontend。走査中にallocated slotとBackend候補を記録し、
    // 事後的に支持されたRecovery bubbleを重ねて最終分類へする。
    if (cycleCount > MAX_EXACT_TOP_DOWN_CYCLE_COUNT) {
        return null;
    }
    const { allocationStage, executionStage } = reference;
    const allocationWidth = reference.allocationWidth;
    const slotCount = cycleCount * allocationWidth;
    const workingBytes = slotCount + cycleCount;
    if (!Number.isSafeInteger(slotCount) ||
        workingBytes > MAX_TOP_DOWN_WORKING_BYTES) {
        return null;
    }

    const slots = new Uint8Array(slotCount);
    slots.fill(TopDownSlotClass.FRONTEND_BOUND);
    const emptySlotClasses = new Uint8Array(cycleCount);
    emptySlotClasses.fill(TopDownSlotClass.FRONTEND_BOUND);
    const previousRecoveryStartByThread = new Map<number, number>();
    const pendingRecoveryStartByThread = new Map<number, number>();
    const recoveryWindows: Array<readonly [startCycle: number, endCycle: number]> = [];
    const recoveryLatencyHistogram = new Map<number, number>();
    let recoveryWindowCount = 0;
    // O3PipeViewにallocation-side recovery eventはないため、以下はPMU TMAの厳密な
    // 復元ではなく、後にflushと分かった命令列から作る事後的な因果分類である。
    const admissionByStage = new Map<string, Readonly<TopDownAdmission>>();
    for (const admission of reference.admissionStages) {
        if (admission.stage.laneID === allocationStage.laneID) {
            admissionByStage.set(admission.stage.stageName, admission);
        }
    }
    const completionStageNames = new Set(reference.completionStages.map((stage) => stage.stageName));
    let workSinceYield = 0;
    // 二回目のOp走査: allocation済みslot、入口停滞、recovery候補を集める。
    for (let id = 0; id <= lastID; id++) {
        if (isCanceled?.()) {
            return null;
        }
        const op = trace.getOpForScan(id);
        if (op === undefined || op.eof) {
            continue;
        }
        const { firstAllocationCycle, completionCycle } = observeAllocationStages(
            op,
            allocationStage.laneID,
            allocationStage.stageName,
            executionStage.stageName,
            completionStageNames,
            admissionByStage,
            (startCycle, endCycle) => {
                // allocation直前のstageに通常より長く留まった区間を入口停滞とする。
                // 命令が後にflushされても、resolution前の空きslotはrecoveryではない。
                markCycleRange(
                    emptySlotClasses,
                    startCycle,
                    endCycle,
                    TopDownSlotClass.BACKEND_BOUND,
                );
            },
        );
        if (firstAllocationCycle !== null) {
            // TMA Level 1のslotはexecution issueではなく、FrontendからBackendへuopを
            // 渡すallocation pointで数える。同じ命令が後段でreplayしても1 slotのままにする。
            addAllocatedSlot(
                slots, allocationWidth, firstAllocationCycle, getOpSlotClass(op),
            );
        }

        const tid = op.tid;
        const previousRecoveryStart = previousRecoveryStartByThread.get(tid);
        if (op.flush) {
            if (previousRecoveryStart !== undefined) {
                // 同じthreadで連続するflush列の直前にあるretiring control-flow命令だけを
                // 原因候補とする。明示cause eventがない形式では、これ以上広い推定をしない。
                pendingRecoveryStartByThread.set(tid, previousRecoveryStart);
                recoveryWindowCount++;
            }
        } else {
            const recoveryStart = pendingRecoveryStartByThread.get(tid);
            if (recoveryStart !== undefined) {
                pendingRecoveryStartByThread.delete(tid);
                if (op.retired && firstAllocationCycle !== null &&
                    firstAllocationCycle >= recoveryStart) {
                    recoveryWindows.push([recoveryStart, firstAllocationCycle]);
                    const latency = Math.floor(firstAllocationCycle - recoveryStart);
                    recoveryLatencyHistogram.set(
                        latency,
                        (recoveryLatencyHistogram.get(latency) ?? 0) + 1,
                    );
                } else {
                    recoveryWindowCount--;
                }
            }
        }
        previousRecoveryStartByThread.delete(tid);
        if (!op.flush && op.retired && firstAllocationCycle !== null &&
            completionCycle !== null && completionCycle > firstAllocationCycle &&
            isLikelyControlFlowLabel(op.labelName)) {
            // completionを、次の命令がflushされた場合のresolution proxyとしてだけ残す。
            previousRecoveryStartByThread.set(tid, completionCycle);
        }

        workSinceYield++;
        if (workSinceYield >= yieldInterval) {
            await yieldToBrowser();
            workSinceYield = 0;
            if (isCanceled?.()) {
                return null;
            }
        }
    }
    const supportedRecovery = getSupportedMinimum(recoveryLatencyHistogram);
    if (supportedRecovery !== null) {
        // 同じ短い回復時間が十分繰り返された時だけ、空slotをRecoveryへ上書きする。
        for (const [startCycle, nextCorrectAllocationCycle] of recoveryWindows) {
            // 実際のcorrect allocationより先へは延ばさない。長いI-cache／ITLB待ちは
            // supported minimumを超えた時点から従来のFrontend／Backend判定へ戻す。
            const endCycle = Math.min(
                nextCorrectAllocationCycle,
                startCycle + supportedRecovery.value,
            );
            markCycleRange(
                emptySlotClasses,
                startCycle,
                endCycle,
                TopDownSlotClass.RECOVERY_BUBBLE,
            );
        }
    }

    for (let cycle = 0; cycle < cycleCount; cycle++) {
        // cycle単位で求めた原因を、そのcycleに残った空slotだけへ反映する。
        const emptyClass = emptySlotClasses[cycle] as TopDownSlotClass;
        if (emptyClass !== TopDownSlotClass.FRONTEND_BOUND) {
            // recoveryは上のmarkCycleRangeでbackendを上書きするため優先される。
            markEmptySlots(slots, allocationWidth, cycle, cycle + 1, emptyClass);
        }
        workSinceYield++;
        if (workSinceYield >= yieldInterval) {
            await yieldToBrowser();
            workSinceYield = 0;
            if (isCanceled?.()) {
                return null;
            }
        }
    }
    return {
        allocationStage,
        executionStage,
        completionStages: reference.completionStages,
        allocationWidth,
        transitionCoverage: reference.transitionCoverage,
        admissionStages: reference.admissionStages,
        recoveryWindowCount,
        minimumRecoveryCycles: supportedRecovery?.value ?? null,
        minimumRecoverySampleCount: supportedRecovery?.sampleCount ?? 0,
        slots,
    };
}

/**
 * 集計層: Detectorが推定したstage構造からTop-down-likeのslot分類を作る。
 *
 * 全allocation slotをUint8Arrayへ保持し、表示解像度に応じたsamplingはRenderer側で行う。
 * 呼出し側はViewを閉じた時やTraceを破棄する時にisCanceledをtrueへする。
 */
export async function buildTopDownData(
    trace: ParsedTrace,
    options: Readonly<TopDownBuildOptions> = {},
): Promise<TopDownData | null> {
    // live解析では最後の正常リタイア命令を、確定したIDとcycleの境界にする。
    const frontierOp = options.live ? trace.getOpFromRID(trace.lastRID) : undefined;
    const cycleCount = Math.max(1, Math.ceil(
        options.live ? frontierOp?.fetchedCycle ?? 0 : trace.lastCycle,
    ));
    let lastID = options.live ? (frontierOp?.id ?? 0) - 1 : trace.lastID;
    const stageLabels = createStageLabels(trace);
    const yieldInterval = Math.max(1, options.yieldInterval ?? DEFAULT_YIELD_INTERVAL);
    const stageStructureDetector = new StageStructureDetector();
    let workSinceYield = 0;
    // 一回目のOp走査はDetectorへ委譲し、Top-down側では構造推定を行わない。
    for (let id = 0; id <= lastID; id++) {
        if (options.isCanceled?.()) {
            return null;
        }
        const op = trace.getOpForScan(id);
        if (options.live && op === undefined) {
            lastID = id - 1;
            break;
        }
        if (op !== undefined) {
            stageStructureDetector.observe(op);
        }
        workSinceYield++;
        if (workSinceYield >= yieldInterval) {
            await yieldToBrowser();
            workSinceYield = 0;
        }
    }
    if (options.isCanceled?.()) {
        return null;
    }

    const detectedStructure = stageStructureDetector.finish();
    const stageReference = detectedStructure === null
        ? null
        : resolveStageStructure(detectedStructure, stageLabels);
    const analysis = stageReference === null
        ? null
        : await classifyTopDownSlots(
            trace,
            stageReference,
            cycleCount,
            lastID,
            yieldInterval,
            options.isCanceled,
        );
    if (options.isCanceled?.()) {
        return null;
    }
    return {
        cycleCount,
        sourceLastID: lastID,
        analysis,
    };
}

function growLiveSlots(
    analysis: Readonly<TopDownAnalysis>,
    cycleCount: number,
): TopDownAnalysis | null {
    // 読み込み途中の更新ごとに配列をcopyしないよう、cycle容量を倍増する。
    const width = analysis.allocationWidth;
    let capacity = Math.floor(analysis.slots.length / width);
    if (cycleCount <= capacity) {
        return analysis;
    }
    while (capacity < cycleCount) {
        capacity = Math.min(MAX_EXACT_TOP_DOWN_CYCLE_COUNT, Math.max(1, capacity * 2));
        if (capacity === MAX_EXACT_TOP_DOWN_CYCLE_COUNT && capacity < cycleCount) {
            return null;
        }
    }
    const slotCount = capacity * width;
    if (!Number.isSafeInteger(slotCount) || slotCount > MAX_TOP_DOWN_WORKING_BYTES) {
        return null;
    }
    const slots = new Uint8Array(slotCount);
    slots.fill(TopDownSlotClass.FRONTEND_BOUND);
    slots.set(analysis.slots);
    return { ...analysis, slots };
}

/**
 * 確定済みのstage構造を使い、Parserが新たに公開したOpだけをslotへ反映する。
 * recovery統計とallocation幅は再推定せず、読み込み完了時の全体解析で補正する。
 */
export function updateTopDownData(
    data: Readonly<TopDownData>,
    trace: ParsedTrace,
): TopDownData {
    if (data.analysis === null) {
        return data;
    }
    const frontierOp = trace.getOpFromRID(trace.lastRID);
    if (frontierOp === undefined) {
        return data;
    }
    const cycleCount = Math.max(data.cycleCount, Math.ceil(frontierOp.fetchedCycle), 1);
    const analysis = growLiveSlots(data.analysis, cycleCount);
    if (analysis === null) {
        return data;
    }

    const admissionByStage = new Map<string, Readonly<TopDownAdmission>>();
    for (const admission of analysis.admissionStages) {
        if (admission.stage.laneID === analysis.allocationStage.laneID) {
            admissionByStage.set(admission.stage.stageName, admission);
        }
    }
    const completionStageNames = new Set(
        analysis.completionStages.map((stage) => stage.stageName),
    );
    const addOp = (op: Readonly<Op>): void => {
        if (op.eof) {
            return;
        }
        const { firstAllocationCycle } = observeAllocationStages(
            op,
            analysis.allocationStage.laneID,
            analysis.allocationStage.stageName,
            analysis.executionStage.stageName,
            completionStageNames,
            admissionByStage,
            (startCycle, endCycle) => {
                markEmptySlots(
                    analysis.slots,
                    analysis.allocationWidth,
                    startCycle,
                    endCycle,
                    TopDownSlotClass.BACKEND_BOUND,
                );
            },
        );
        if (firstAllocationCycle === null) {
            return;
        }
        addAllocatedSlot(
            analysis.slots,
            analysis.allocationWidth,
            firstAllocationCycle,
            getOpSlotClass(op),
        );
    };

    let sourceLastID = data.sourceLastID;
    for (let id = data.sourceLastID + 1; id < frontierOp.id; id++) {
        const op = trace.getOpForScan(id);
        if (op === undefined) {
            break;
        }
        addOp(op);
        sourceLastID = id;
    }
    if (analysis === data.analysis && cycleCount === data.cycleCount &&
        sourceLastID === data.sourceLastID) {
        return data;
    }
    return {
        cycleCount,
        sourceLastID,
        analysis,
    };
}

export function getTopDownBreakdown(
    data: Readonly<TopDownData>,
    startCycle: number,
    endCycle: number,
    maxSampleCycles = Number.POSITIVE_INFINITY,
): TopDownBreakdown | null {
    // 縮小表示ではglobal cycleへ揃えた2の冪strideでcycleを選び、選んだcycleの
    // 全slotを数える。同一cycle内のslotだけが偏って選ばれることを避ける。
    const analysis = data.analysis;
    if (analysis === null || endCycle <= startCycle) {
        return null;
    }
    const allocationWidth = analysis.allocationWidth;
    if (allocationWidth <= 0) {
        return null;
    }
    const firstCycle = Math.max(0, Math.min(data.cycleCount, Math.floor(startCycle)));
    const lastCycle = Math.max(firstCycle, Math.min(data.cycleCount, Math.ceil(endCycle)));
    const cycleCount = lastCycle - firstCycle;
    if (cycleCount === 0) {
        return null;
    }
    const sampleLimit = Number.isFinite(maxSampleCycles)
        ? Math.max(1, Math.floor(maxSampleCycles))
        : cycleCount;
    const minimumStride = Math.max(1, Math.ceil(cycleCount / sampleLimit));
    const samplingStride = 2 ** Math.ceil(Math.log2(minimumStride));
    let sampleCycle = samplingStride === 1
        ? firstCycle
        : Math.ceil(firstCycle / samplingStride) * samplingStride;
    if (sampleCycle >= lastCycle) {
        sampleCycle = firstCycle;
    }

    const counts = [0, 0, 0, 0, 0, 0];
    let sampledCycleCount = 0;
    for (let cycle = sampleCycle; cycle < lastCycle; cycle += samplingStride) {
        const firstSlot = cycle * allocationWidth;
        const lastSlot = firstSlot + allocationWidth;
        for (let slot = firstSlot; slot < lastSlot; slot++) {
            counts[analysis.slots[slot]]++;
        }
        sampledCycleCount++;
    }
    const totalSlots = sampledCycleCount * allocationWidth;
    return {
        analysis,
        startCycle: firstCycle,
        endCycle: lastCycle,
        totalSlots,
        retiringSlots: counts[TopDownSlotClass.RETIRING],
        squashedSlots: counts[TopDownSlotClass.SQUASHED],
        recoveryBubbleSlots: counts[TopDownSlotClass.RECOVERY_BUBBLE],
        unresolvedSlots: counts[TopDownSlotClass.UNRESOLVED],
        frontendBound: counts[TopDownSlotClass.FRONTEND_BOUND],
        backendBound: counts[TopDownSlotClass.BACKEND_BOUND],
        sampledCycleCount,
        samplingStride,
    };
}
