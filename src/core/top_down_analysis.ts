/**
 * ParsedTraceからTop-down-likeのslot分類を構築する。UIやCanvasには依存しない。
 *
 * 解析は次の順で行う。
 *
 * 1. Fetch／Commit activityを数えながら、allocation frontier候補を検出する。
 * 2. 同じsampleを再走査し、候補集合と観測幅を確定する。
 * 3. 構造を検出できた場合だけ、各cycleのslot分類と残りのactivity系列を構築する。
 * 4. 確定済みprefixを32-cycle binへ移し、未確定の末尾だけ1-cycle精度で残す。
 *
 * Rendererには保持形式を見せず、範囲集計時にbinとexact tailを合成する。
 */
import {
    type DetectedStage,
    type DetectedStageGroup,
    type DetectedStageObservation,
    type DetectedStageStructure,
    StageStructureDetector,
} from "./stage_structure_detector";
import {
    createCycleActivity,
    getCycleActivityByteLength,
    growCycleActivity,
    incrementCycleActivity,
    sealCycleActivity,
    setCycleLatency,
    TRACE_NAVIGATOR_BIN_CYCLE_COUNT,
    type CycleActivity,
} from "./cycle_activity_analysis";
import type { Op, ParsedTrace } from "./model";

const DEFAULT_YIELD_INTERVAL = 50_000;
export const TOP_DOWN_INITIAL_SNAPSHOT_OP_COUNT = 50_000;
const MAX_EXACT_TOP_DOWN_CYCLE_COUNT = 4 * 1024 * 1024;
const MAX_TOP_DOWN_WORKING_BYTES = 128 * 1024 * 1024;
const TOP_DOWN_SLOT_CLASS_COUNT = 6;
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
    // live更新もDetectorが確定した観測規則だけを使い、stage構造を再解釈しない。
    readonly stageStructure: Readonly<DetectedStageStructure>;
    readonly allocationStage: TopDownStage;
    readonly executionStage: TopDownStage;
    readonly allocationWidth: number;
    readonly transitionCoverage: number;
    readonly admissionStages: readonly TopDownAdmission[];
    readonly recoveryWindowCount: number;
    readonly minimumRecoveryCycles: number | null;
    readonly minimumRecoverySampleCount: number;
    // 確定済みprefixはbin * categoryのslot数、未確定末尾は1 byte／slotで持つ。
    readonly slotCounts: Uint16Array;
    readonly tailSlots: Uint8Array;
}

export interface TopDownAdmission {
    readonly stage: TopDownStage;
    readonly typicalLatency: number;
}

export interface TopDownData {
    readonly cycleCount: number;
    // このcycleより前は、公開済みOpのstage／lifecycle情報が揃っている。
    readonly confirmedCycle: number;
    // exact tailには表示境界より後のcommit等も保持するため、別に観測終端を持つ。
    readonly observedCycleCount: number;
    readonly sourceLastID: number;
    readonly cycleActivity: CycleActivity;
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
    readonly binCycleCount?: number;
}

function formatStage(trace: ParsedTrace, stage: Readonly<DetectedStage>): TopDownStage {
    // Detectorの結果は必ずTrace内のstageなので、ここでは表示名だけを補う。
    const showLaneName = trace.stageLevelMap.laneNum > 1;
    const laneName = trace.stageLevelMap.getLaneName(stage.laneID);
    const label = showLaneName && laneName !== undefined
        ? `${laneName}/${stage.stageName}`
        : stage.stageName;
    return { ...stage, label };
}

function formatStageGroup(trace: ParsedTrace, group: Readonly<DetectedStageGroup>): TopDownStage {
    const stageName = group.stageNames.join("/");
    return formatStage(trace, { laneID: group.laneID, stageName });
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
    sealedCycle: number,
    allocationWidth: number,
    cycle: number,
    slotClass: TopDownSlotClass,
): void {
    const localCycle = Math.floor(cycle) - sealedCycle;
    const firstSlot = localCycle * allocationWidth;
    const endSlot = firstSlot + allocationWidth;
    if (!Number.isFinite(firstSlot) || firstSlot < 0 || endSlot > slots.length) {
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
    sealedCycle: number,
    allocationWidth: number,
    startCycle: number,
    endCycle: number,
    slotClass: TopDownSlotClass,
): void {
    const capacity = Math.floor(slots.length / allocationWidth);
    const firstCycle = Math.max(0, Math.min(
        capacity,
        Math.floor(startCycle) - sealedCycle,
    ));
    const lastCycle = Math.max(firstCycle, Math.min(
        capacity,
        Math.ceil(endCycle) - sealedCycle,
    ));
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

function getOpSlotClass(op: Readonly<Op>): TopDownSlotClass {
    // allocationされた命令は最終状態だけで分類し、後段での待ち時間はslot数へ足さない。
    return op.retired
        ? TopDownSlotClass.RETIRING
        : op.flush
            ? TopDownSlotClass.SQUASHED
            : TopDownSlotClass.UNRESOLVED;
}

function observeOpLifecycle(op: Readonly<Op>, activity: CycleActivity): void {
    if (op.eof) {
        return;
    }
    // Fetch／Commitはstage構造に依存しないため、Detectorと同じ走査で常に集計する。
    incrementCycleActivity(activity, "fetch", op.fetchedCycle, op.flush);
    if (op.retired) {
        incrementCycleActivity(activity, "commit", op.retiredCycle);
    }
}

function recordDetectedStageActivity(
    op: Readonly<Op>,
    observation: Readonly<DetectedStageObservation>,
    activity: CycleActivity,
): void {
    if (observation.issueCycle !== null) {
        incrementCycleActivity(activity, "issue", observation.issueCycle, op.flush);
        if (observation.executionLatency !== null) {
            setCycleLatency(activity, observation.issueCycle, observation.executionLatency);
        }
    }
    if (op.flush && observation.allocationCycle !== null) {
        incrementCycleActivity(activity, "flush", observation.allocationCycle);
    }
}

async function classifyTopDownSlots(
    trace: ParsedTrace,
    structure: Readonly<DetectedStageStructure>,
    cycleActivity: CycleActivity,
    cycleCount: number,
    lastID: number,
    yieldInterval: number,
    isCanceled?: () => boolean,
): Promise<TopDownAnalysis | null> {
    // 未使用slotの既定値はFrontend。確定境界を決めるまでは従来どおりcycle別に分類する。
    if (cycleCount > MAX_EXACT_TOP_DOWN_CYCLE_COUNT) {
        return null;
    }
    const { allocationStage } = structure;
    const allocationWidth = allocationStage.width;
    const slotCount = cycleCount * allocationWidth;
    if (!Number.isSafeInteger(slotCount) ||
        allocationWidth * cycleActivity.binCycleCount > 0xffff ||
        slotCount + getCycleActivityByteLength(cycleActivity) >
            MAX_TOP_DOWN_WORKING_BYTES) {
        return null;
    }
    const tailSlots = new Uint8Array(slotCount);
    tailSlots.fill(TopDownSlotClass.FRONTEND_BOUND);
    const previousRecoveryStartByThread = new Map<number, number>();
    const pendingRecoveryStartByThread = new Map<number, number>();
    const recoveryWindows: Array<readonly [startCycle: number, endCycle: number]> = [];
    const recoveryLatencyHistogram = new Map<number, number>();
    let recoveryWindowCount = 0;
    // O3PipeViewにallocation-side recovery eventはないため、以下はPMU TMAの厳密な
    // 復元ではなく、後にflushと分かった命令列から作る事後的な因果分類である。
    let workSinceYield = 0;
    // 三回目のOp走査: 確定済み構造の観測値からslotとrecovery候補を集める。
    for (let id = 0; id <= lastID; id++) {
        if (isCanceled?.()) {
            return null;
        }
        const op = trace.getOpForScan(id);
        if (op === undefined || op.eof) {
            continue;
        }
        const observation = structure.observe(op);
        recordDetectedStageActivity(op, observation, cycleActivity);
        if (observation.admissionStallStartCycle !== null &&
            observation.admissionStallEndCycle !== null) {
            // 命令が後にflushされても、resolution前の空きslotはrecoveryではない。
            markEmptySlots(
                tailSlots,
                0,
                allocationWidth,
                observation.admissionStallStartCycle,
                observation.admissionStallEndCycle,
                TopDownSlotClass.BACKEND_BOUND,
            );
        }
        if (observation.allocationCycle !== null) {
            // TMA Level 1のslotはexecution issueではなく、FrontendからBackendへuopを
            // 渡すallocation pointで数える。同じ命令が後段でreplayしても1 slotのままにする。
            addAllocatedSlot(
                tailSlots,
                0,
                allocationWidth,
                observation.allocationCycle,
                getOpSlotClass(op),
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
                if (op.retired && observation.allocationCycle !== null &&
                    observation.allocationCycle >= recoveryStart) {
                    recoveryWindows.push([recoveryStart, observation.allocationCycle]);
                    const latency = Math.floor(observation.allocationCycle - recoveryStart);
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
        if (!op.flush && op.retired && observation.allocationCycle !== null &&
            observation.completionCycle !== null &&
            observation.completionCycle > observation.allocationCycle &&
            isLikelyControlFlowLabel(op.labelName)) {
            // completionを、次の命令がflushされた場合のresolution proxyとしてだけ残す。
            previousRecoveryStartByThread.set(tid, observation.completionCycle);
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
            markEmptySlots(
                tailSlots,
                0,
                allocationWidth,
                startCycle,
                endCycle,
                TopDownSlotClass.RECOVERY_BUBBLE,
            );
        }
    }
    return {
        stageStructure: structure,
        allocationStage: formatStageGroup(trace, allocationStage),
        executionStage: formatStageGroup(trace, structure.executionStage),
        allocationWidth,
        transitionCoverage: structure.transitionCoverage,
        admissionStages: structure.admissionStages.map((admission) => ({
            stage: formatStage(trace, admission),
            typicalLatency: admission.typicalLatency,
        })),
        recoveryWindowCount,
        minimumRecoveryCycles: supportedRecovery?.value ?? null,
        minimumRecoverySampleCount: supportedRecovery?.sampleCount ?? 0,
        slotCounts: new Uint16Array(0),
        tailSlots,
    };
}

function growSlotCounts(values: Uint16Array, required: number): Uint16Array {
    if (values.length >= required) {
        return values;
    }
    const capacity = values.length === 0
        ? required
        : Math.max(required, values.length * 2);
    const grown = new Uint16Array(capacity);
    grown.set(values);
    return grown;
}

function growLiveAnalysis(
    analysis: Readonly<TopDownAnalysis>,
    sealedCycle: number,
    cycleCapacity: number,
): TopDownAnalysis | null {
    const width = analysis.allocationWidth;
    const requiredCycles = Math.max(1, cycleCapacity - sealedCycle);
    const currentCycles = Math.floor(analysis.tailSlots.length / width);
    if (requiredCycles <= currentCycles) {
        return analysis;
    }
    const capacity = Math.max(requiredCycles, currentCycles * 2);
    if (capacity > MAX_EXACT_TOP_DOWN_CYCLE_COUNT) {
        return null;
    }
    const tailSlots = new Uint8Array(capacity * width);
    tailSlots.fill(TopDownSlotClass.FRONTEND_BOUND);
    tailSlots.set(analysis.tailSlots);
    return { ...analysis, tailSlots };
}

function sealTopDownAnalysis(
    analysis: Readonly<TopDownAnalysis>,
    sealedCycle: number,
    nextSealedCycle: number,
    cycleCount: number,
    binCycleCount: number,
): TopDownAnalysis {
    if (nextSealedCycle <= sealedCycle) {
        return analysis;
    }
    const width = analysis.allocationWidth;
    const firstBin = sealedCycle / binCycleCount;
    const sealedBinCount = nextSealedCycle / binCycleCount;
    const slotCounts = growSlotCounts(
        analysis.slotCounts,
        sealedBinCount * TOP_DOWN_SLOT_CLASS_COUNT,
    );
    for (let bin = firstBin; bin < sealedBinCount; bin++) {
        const firstCycle = (bin - firstBin) * binCycleCount;
        const lastCycle = firstCycle + binCycleCount;
        const firstCount = bin * TOP_DOWN_SLOT_CLASS_COUNT;
        for (let cycle = firstCycle; cycle < lastCycle; cycle++) {
            const firstSlot = cycle * width;
            for (let slot = firstSlot; slot < firstSlot + width; slot++) {
                slotCounts[firstCount + analysis.tailSlots[slot]]++;
            }
        }
    }
    const removedSlots = (nextSealedCycle - sealedCycle) * width;
    const tailCycles = Math.max(1, cycleCount - nextSealedCycle);
    const tailSlots = new Uint8Array(tailCycles * width);
    tailSlots.fill(TopDownSlotClass.FRONTEND_BOUND);
    tailSlots.set(analysis.tailSlots.subarray(
        removedSlots,
        removedSlots + tailSlots.length,
    ));
    return { ...analysis, slotCounts, tailSlots };
}

function sealTopDownData(data: Readonly<TopDownData>): TopDownData {
    const oldSealedCycle = data.cycleActivity.sealedCycle;
    const cycleActivity = sealCycleActivity(
        data.cycleActivity,
        data.confirmedCycle,
        data.observedCycleCount,
    );
    const nextSealedCycle = cycleActivity.sealedCycle;
    if (nextSealedCycle <= oldSealedCycle) {
        return data;
    }
    const analysis = data.analysis === null
        ? null
        : sealTopDownAnalysis(
            data.analysis,
            oldSealedCycle,
            nextSealedCycle,
            data.observedCycleCount,
            cycleActivity.binCycleCount,
        );
    return { ...data, cycleActivity, analysis };
}

/**
 * 集計層: stage非依存activityを集計し、Detectorが推定できた場合はslot分類も作る。
 *
 * 32-cycle binを既定とし、局所検証だけbinCycleCountで解像度を変更できる。
 * 呼出し側はViewを閉じた時やTraceを破棄する時にisCanceledをtrueへする。
 */
export async function buildTopDownData(
    trace: ParsedTrace,
    options: Readonly<TopDownBuildOptions> = {},
): Promise<TopDownData | null> {
    const snapshotLastID = trace.lastID;
    const traceCycleCount = Math.max(1, Math.ceil(trace.lastCycle));
    // lastCycleと同じcycleにあるretireも、将来表示境界が進んだ時のためtailへ残す。
    const observedCycleCount = traceCycleCount + 1;
    let lastID = snapshotLastID;
    let confirmedCycle = 0;
    const yieldInterval = Math.max(1, options.yieldInterval ?? DEFAULT_YIELD_INTERVAL);
    const stageStructureDetector = new StageStructureDetector();
    const cycleActivity = createCycleActivity(
        observedCycleCount,
        options.binCycleCount ?? TRACE_NAVIGATOR_BIN_CYCLE_COUNT,
    );
    let workSinceYield = 0;
    // OpStoreへ公開済みの連続IDはretire／flushまで完結している。
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
            observeOpLifecycle(op, cycleActivity);
            if (!op.eof) {
                confirmedCycle = op.fetchedCycle;
            }
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

    const stageStructureMeasurement = stageStructureDetector.finish();
    workSinceYield = 0;
    // 二回目のsample走査は候補集合への投入だけを見て、正確な観測幅を求める。
    if (stageStructureMeasurement !== null) {
        for (let id = 0; id <= lastID; id++) {
            if (options.isCanceled?.()) {
                return null;
            }
            const op = trace.getOpForScan(id);
            if (op !== undefined) {
                stageStructureMeasurement.observe(op);
            }
            workSinceYield++;
            if (workSinceYield >= yieldInterval) {
                await yieldToBrowser();
                workSinceYield = 0;
            }
        }
    }
    const structure = stageStructureMeasurement?.finish() ?? null;
    const analysis = structure === null
        ? null
        : await classifyTopDownSlots(
            trace,
            structure,
            cycleActivity,
            observedCycleCount,
            lastID,
            yieldInterval,
            options.isCanceled,
        );
    if (options.isCanceled?.()) {
        return null;
    }
    const finalCycle = options.live ? confirmedCycle : traceCycleCount;
    return sealTopDownData({
        cycleCount: Math.max(1, Math.ceil(finalCycle)),
        confirmedCycle: finalCycle,
        observedCycleCount,
        sourceLastID: lastID,
        cycleActivity,
        analysis,
    });
}

/**
 * 初期sampleで確定したstage構造を使い、Parserが公開した連続Opを一度だけ反映する。
 * finishedでは再走査せず、EOF命令と末尾cycleを反映して残りの完成binを確定する。
 */
export function updateTopDownData(
    data: Readonly<TopDownData>,
    trace: ParsedTrace,
    finished = false,
): TopDownData {
    const observedCycleCount = Math.max(
        data.observedCycleCount,
        Math.ceil(trace.lastCycle) + 1,
        1,
    );
    let cycleActivity = growCycleActivity(data.cycleActivity, observedCycleCount);
    const analysis = data.analysis === null
        ? null
        : growLiveAnalysis(
            data.analysis,
            data.cycleActivity.sealedCycle,
            observedCycleCount,
        );
    if ((analysis?.tailSlots.byteLength ?? 0) +
        getCycleActivityByteLength(cycleActivity) > MAX_TOP_DOWN_WORKING_BYTES) {
        return data;
    }
    if (data.analysis !== null && analysis === null) {
        return data;
    }

    let sourceLastID = data.sourceLastID;
    let confirmedCycle = data.confirmedCycle;
    for (let id = data.sourceLastID + 1; id <= trace.lastID; id++) {
        const op = trace.getOpForScan(id);
        if (op === undefined) {
            break;
        }
        sourceLastID = id;
        if (op.eof) {
            continue;
        }
        observeOpLifecycle(op, cycleActivity);
        confirmedCycle = op.fetchedCycle;
        if (analysis === null) {
            continue;
        }
        const observation = analysis.stageStructure.observe(op);
        recordDetectedStageActivity(op, observation, cycleActivity);
        if (observation.admissionStallStartCycle !== null &&
            observation.admissionStallEndCycle !== null) {
            markEmptySlots(
                analysis.tailSlots,
                cycleActivity.sealedCycle,
                analysis.allocationWidth,
                observation.admissionStallStartCycle,
                observation.admissionStallEndCycle,
                TopDownSlotClass.BACKEND_BOUND,
            );
        }
        if (observation.allocationCycle !== null) {
            addAllocatedSlot(
                analysis.tailSlots,
                cycleActivity.sealedCycle,
                analysis.allocationWidth,
                observation.allocationCycle,
                getOpSlotClass(op),
            );
        }
    }
    // EOFでは既存Opを再走査せず、最後のcycleまでを確定領域へ進める。
    const confirmedEnd = finished
        ? Math.max(1, Math.ceil(trace.lastCycle))
        : confirmedCycle;
    if (sourceLastID === data.sourceLastID &&
        observedCycleCount === data.observedCycleCount &&
        confirmedEnd === data.confirmedCycle) {
        return data;
    }
    return sealTopDownData({
        cycleCount: Math.max(1, Math.ceil(confirmedEnd)),
        confirmedCycle: confirmedEnd,
        observedCycleCount,
        sourceLastID,
        cycleActivity,
        analysis,
    });
}

export function getTopDownBreakdown(
    data: Readonly<TopDownData>,
    startCycle: number,
    endCycle: number,
    _maxSampleCycles = Number.POSITIVE_INFINITY,
): TopDownBreakdown | null {
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
    if (lastCycle === firstCycle) {
        return null;
    }
    const { binCycleCount, sealedCycle } = data.cycleActivity;
    const counts = [0, 0, 0, 0, 0, 0];
    const binnedEnd = Math.min(lastCycle, sealedCycle);
    if (firstCycle < binnedEnd) {
        const firstBin = Math.floor(firstCycle / binCycleCount);
        const lastBin = Math.ceil(binnedEnd / binCycleCount);
        for (let bin = firstBin; bin < lastBin; bin++) {
            const binStart = bin * binCycleCount;
            const binEnd = binStart + binCycleCount;
            const overlap = Math.max(0, Math.min(binnedEnd, binEnd) -
                Math.max(firstCycle, binStart));
            const fraction = overlap / binCycleCount;
            const firstCount = bin * TOP_DOWN_SLOT_CLASS_COUNT;
            for (let slotClass = 0; slotClass < TOP_DOWN_SLOT_CLASS_COUNT; slotClass++) {
                counts[slotClass] += analysis.slotCounts[firstCount + slotClass] * fraction;
            }
        }
    }
    const tailStart = Math.max(firstCycle, sealedCycle);
    for (let cycle = tailStart; cycle < lastCycle; cycle++) {
        const firstSlot = (cycle - sealedCycle) * allocationWidth;
        for (let slot = firstSlot; slot < firstSlot + allocationWidth; slot++) {
            counts[analysis.tailSlots[slot]]++;
        }
    }
    const sampledCycleCount = lastCycle - firstCycle;
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
        samplingStride: firstCycle < sealedCycle ? binCycleCount : 1,
    };
}
