/**
 * ParsedTraceからTop-down-likeのslot分類を構築する。UIやCanvasには依存しない。
 */
import {
    type DetectedAllocationStage,
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
    RETIRING,
    SQUASHED,
    RECOVERY_BUBBLE,
    FRONTEND_BOUND,
    BACKEND_BOUND,
    UNRESOLVED,
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
    readonly allocationWidth: number;
    readonly transitionCoverage: number;
    readonly admissionStages: readonly TopDownAdmission[];
    readonly recoveryWindowCount: number;
    readonly minimumRecoveryCycles: number | null;
    readonly minimumRecoverySampleCount: number;
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

interface StageRecord extends TopDownStage {
    readonly rowIndex: number;
    readonly laneID: number;
    startCount: number;
}

function createRows(trace: ParsedTrace) {
    const rows: StageRecord[] = [];
    const rowIndices = new Map<number, Map<string, number>>();
    const showLaneName = trace.stageLevelMap.laneNum > 1;
    const laneNames = [...trace.stageLevelMap.laneNames].sort((left, right) => {
        const leftID = trace.stageLevelMap.getLaneID(left) ?? 0;
        const rightID = trace.stageLevelMap.getLaneID(right) ?? 0;
        return trace.stageLevelMap.getLanePosition(leftID) -
            trace.stageLevelMap.getLanePosition(rightID);
    });
    for (const laneName of laneNames) {
        const laneID = trace.stageLevelMap.getLaneID(laneName);
        if (laneID === undefined) {
            continue;
        }
        const laneRows = new Map<string, number>();
        rowIndices.set(laneID, laneRows);
        for (const stageName of trace.stageLevelMap.getStageNames(laneName)) {
            laneRows.set(stageName, rows.length);
            rows.push({
                rowIndex: rows.length,
                laneID,
                stageName,
                label: showLaneName ? `${laneName}/${stageName}` : stageName,
                startCount: 0,
            });
        }
    }
    return { rows, rowIndices };
}

type StageTransitionCounts = ReadonlyMap<number, ReadonlyMap<number, number>>;
type StageTransitionLatencies = ReadonlyMap<
    number,
    ReadonlyMap<number, ReadonlyMap<number, number>>
>;

interface StageAllocationReference {
    readonly allocationRow: StageRecord;
    readonly executionRow: StageRecord;
    readonly allocationWidth: number;
    readonly transitionCoverage: number;
    readonly admissionRows: readonly StageAdmissionReference[];
}

interface StageAdmissionReference {
    readonly row: StageRecord;
    readonly typicalLatency: number;
    readonly transitionCount: number;
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

function buildAllocationReference(
    detection: Readonly<DetectedAllocationStage>,
    rows: readonly StageRecord[],
    rowIndices: ReadonlyMap<number, ReadonlyMap<string, number>>,
    transitions: StageTransitionCounts,
    transitionLatencies: StageTransitionLatencies,
): StageAllocationReference | null {
    const allocationRowIndex = rowIndices.get(detection.laneID)?.get(detection.stageName);
    if (allocationRowIndex === undefined) {
        return null;
    }
    const successors = transitions.get(allocationRowIndex);
    let executionRowIndex = -1;
    let transitionCount = 0;
    for (const [candidateIndex, count] of successors ?? []) {
        if (count > transitionCount) {
            executionRowIndex = candidateIndex;
            transitionCount = count;
        }
    }
    const allocationRow = rows[allocationRowIndex];
    if (allocationRow === undefined || rows[executionRowIndex] === undefined ||
        detection.width <= 0) {
        return null;
    }
    const allocationStarts = allocationRow.startCount;
    const transitionCoverage = allocationStarts === 0
        ? 0
        : Math.min(1, transitionCount / allocationStarts);
    const admissionRows: StageAdmissionReference[] = [];
    for (const [rowIndex, successors] of transitions) {
        const count = successors.get(allocationRowIndex) ?? 0;
        const histogram = transitionLatencies.get(rowIndex)?.get(allocationRowIndex);
        if (count <= 0 || histogram === undefined || histogram.size === 0) {
            continue;
        }
        let typicalLatency = 0;
        let typicalCount = -1;
        for (const [latency, latencyCount] of histogram) {
            // 同数なら短い方を選ぶ。通常経路と長いstallが少数ずつしかない短いtraceでも、
            // stall側を基準にして見逃すことを避ける。
            if (latencyCount > typicalCount ||
                (latencyCount === typicalCount && latency < typicalLatency)) {
                typicalLatency = latency;
                typicalCount = latencyCount;
            }
        }
        admissionRows.push({ row: rows[rowIndex], typicalLatency, transitionCount: count });
    }
    admissionRows.sort((left, right) =>
        right.transitionCount - left.transitionCount || left.row.rowIndex - right.row.rowIndex);
    return {
        allocationRow,
        executionRow: rows[executionRowIndex],
        allocationWidth: detection.width,
        transitionCoverage,
        admissionRows,
    };
}

function addExactInterval(
    diff: Int32Array,
    cycleCount: number,
    startCycle: number,
    endCycle: number,
): void {
    const start = Math.max(0, Math.min(cycleCount, Math.floor(startCycle)));
    const end = Math.max(0, Math.min(cycleCount, Math.ceil(endCycle)));
    if (end <= start) {
        return;
    }
    diff[start]++;
    diff[end]--;
}

function addAllocatedSlot(
    slots: Uint8Array,
    usedSlots: Uint16Array,
    allocationWidth: number,
    cycle: number,
    slotClass: TopDownSlotClass,
): void {
    const integerCycle = Math.floor(cycle);
    if (integerCycle < 0 || integerCycle >= usedSlots.length) {
        return;
    }
    const used = usedSlots[integerCycle];
    if (used < allocationWidth) {
        slots[integerCycle * allocationWidth + used] = slotClass;
        usedSlots[integerCycle] = used + 1;
    }
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
    admissions: ReadonlyMap<string, Readonly<AdmissionLatency>>,
    onAdmissionStall: (startCycle: number, endCycle: number) => void,
): AllocationStageObservation {
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
            // executionの直後に始まるstageを、stage名に依存しないComplete proxyにする。
            completionCycle = stage.startCycle;
        }
    }
    return { firstAllocationCycle, completionCycle };
}

async function classifyTopDownSlots(
    trace: ParsedTrace,
    reference: Readonly<StageAllocationReference>,
    cycleCount: number,
    lastID: number,
    yieldInterval: number,
    isCanceled?: () => boolean,
): Promise<TopDownAnalysis | null> {
    if (cycleCount > MAX_EXACT_TOP_DOWN_CYCLE_COUNT) {
        return null;
    }
    const { allocationRow, executionRow } = reference;
    const allocationWidth = reference.allocationWidth;
    const slotCount = cycleCount * allocationWidth;
    const workingBytes = slotCount * Uint8Array.BYTES_PER_ELEMENT +
        cycleCount * Uint16Array.BYTES_PER_ELEMENT +
        (cycleCount + 1) * Int32Array.BYTES_PER_ELEMENT * 2;
    if (!Number.isSafeInteger(slotCount) || allocationWidth > 0xffff ||
        workingBytes > MAX_TOP_DOWN_WORKING_BYTES) {
        return null;
    }

    const slots = new Uint8Array(slotCount);
    const usedSlots = new Uint16Array(cycleCount);
    const backendAdmissionDiff = new Int32Array(cycleCount + 1);
    const previousRecoveryStartByThread = new Map<number, number>();
    const pendingRecoveryStartByThread = new Map<number, number>();
    const recoveryWindows: Array<readonly [startCycle: number, endCycle: number]> = [];
    const recoveryLatencyHistogram = new Map<number, number>();
    let recoveryWindowCount = 0;
    // O3PipeViewにallocation-side recovery eventはないため、以下はPMU TMAの厳密な
    // 復元ではなく、後にflushと分かった命令列から作る事後的な因果分類である。
    const admissionRowsByStage = new Map<string, Readonly<StageAdmissionReference>>();
    for (const admission of reference.admissionRows) {
        if (admission.row.laneID === allocationRow.laneID) {
            admissionRowsByStage.set(admission.row.stageName, admission);
        }
    }
    let workSinceYield = 0;
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
            allocationRow.laneID,
            allocationRow.stageName,
            executionRow.stageName,
            admissionRowsByStage,
            (startCycle, endCycle) => {
                // allocation直前のstageに通常より長く留まった区間を入口停滞とする。
                // 命令が後にflushされても、resolution前の空きslotはrecoveryではない。
                addExactInterval(
                    backendAdmissionDiff, cycleCount, startCycle, endCycle,
                );
            },
        );
        if (firstAllocationCycle !== null) {
            // TMA Level 1のslotはexecution issueではなく、FrontendからBackendへuopを
            // 渡すallocation pointで数える。同じ命令が後段でreplayしても1 slotのままにする。
            const slotClass = op.retired
                ? TopDownSlotClass.RETIRING
                : op.flush
                    ? TopDownSlotClass.SQUASHED
                    : TopDownSlotClass.UNRESOLVED;
            addAllocatedSlot(
                slots, usedSlots, allocationWidth, firstAllocationCycle, slotClass,
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
    const recoveryDiff = new Int32Array(cycleCount + 1);
    if (supportedRecovery !== null) {
        for (const [startCycle, nextCorrectAllocationCycle] of recoveryWindows) {
            // 実際のcorrect allocationより先へは延ばさない。長いI-cache／ITLB待ちは
            // supported minimumを超えた時点から従来のFrontend／Backend判定へ戻す。
            const endCycle = Math.min(
                nextCorrectAllocationCycle,
                startCycle + supportedRecovery.value,
            );
            addExactInterval(recoveryDiff, cycleCount, startCycle, endCycle);
        }
    }

    let backendAdmissionDepth = 0;
    let recoveryDepth = 0;
    for (let cycle = 0; cycle < cycleCount; cycle++) {
        backendAdmissionDepth += backendAdmissionDiff[cycle];
        recoveryDepth += recoveryDiff[cycle];
        let emptyClass = TopDownSlotClass.FRONTEND_BOUND;
        if (recoveryDepth > 0) {
            // resolution後にcorrect pathがallocate可能になるまでの空きslotは、TMAの
            // recovery bubbleに相当する。ただし反復観測した最短回復時間を上限とする。
            emptyClass = TopDownSlotClass.RECOVERY_BUBBLE;
        } else if (backendAdmissionDepth > 0) {
            // 後段queueに命令があるだけではBackendにしない。TMA Level 1はexecution
            // issueではなくallocationを観測するため、入口で実際に止まった場合だけを
            // Backend backpressureとする。最終的にflushされる命令もresolution前は含む。
            emptyClass = TopDownSlotClass.BACKEND_BOUND;
        }
        const firstEmptySlot = cycle * allocationWidth + usedSlots[cycle];
        slots.fill(emptyClass, firstEmptySlot, (cycle + 1) * allocationWidth);
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
        allocationStage: {
            laneID: allocationRow.laneID,
            stageName: allocationRow.stageName,
            label: allocationRow.label,
        },
        executionStage: {
            laneID: executionRow.laneID,
            stageName: executionRow.stageName,
            label: executionRow.label,
        },
        allocationWidth,
        transitionCoverage: reference.transitionCoverage,
        admissionStages: reference.admissionRows.map((admission) => {
            return {
                stage: {
                    laneID: admission.row.laneID,
                    stageName: admission.row.stageName,
                    label: admission.row.label,
                },
                typicalLatency: admission.typicalLatency,
            };
        }),
        recoveryWindowCount,
        minimumRecoveryCycles: supportedRecovery?.value ?? null,
        minimumRecoverySampleCount: supportedRecovery?.sampleCount ?? 0,
        slots,
    };
}

/**
 * 集計層: TraceからTop-down-like表示に必要なstage構造とslot分類を作る。
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
    const { rows, rowIndices } = createRows(trace);
    if (rows.length === 0) {
        return {
            cycleCount,
            sourceLastID: lastID,
            analysis: null,
        };
    }

    const yieldInterval = Math.max(1, options.yieldInterval ?? DEFAULT_YIELD_INTERVAL);
    const stageStructureDetector = new StageStructureDetector();
    const transitionCounts = new Map<number, Map<number, number>>();
    const transitionLatencies = new Map<number, Map<number, Map<number, number>>>();
    let workSinceYield = 0;
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
            for (let laneID = 0; laneID < op.lanes.length; laneID++) {
                const lane = op.lanes[laneID];
                const laneRows = rowIndices.get(laneID);
                if (lane === null || laneRows === undefined) {
                    continue;
                }
                let previousRowIndex: number | null = null;
                let previousStageStart = 0;
                let previousStageEnd = 0;
                for (const stage of lane.stages) {
                    workSinceYield++;
                    const rowIndex = laneRows.get(stage.name);
                    if (rowIndex === undefined) {
                        continue;
                    }
                    // Rendererと同じく0は未close stageの終端を表す。真の0-cycle区間は除外する。
                    const endCycle = stage.endCycle === 0 ? op.retiredCycle : stage.endCycle;
                    if (previousRowIndex !== null && previousRowIndex !== rowIndex) {
                        const successors = transitionCounts.get(previousRowIndex) ?? new Map();
                        successors.set(rowIndex, (successors.get(rowIndex) ?? 0) + 1);
                        transitionCounts.set(previousRowIndex, successors);
                        const latency = Math.min(previousStageEnd, stage.startCycle) -
                            previousStageStart;
                        if (Number.isFinite(latency) && latency >= 0) {
                            const successorLatencies = transitionLatencies.get(previousRowIndex) ??
                                new Map<number, Map<number, number>>();
                            const histogram = successorLatencies.get(rowIndex) ?? new Map();
                            histogram.set(latency, (histogram.get(latency) ?? 0) + 1);
                            successorLatencies.set(rowIndex, histogram);
                            transitionLatencies.set(previousRowIndex, successorLatencies);
                        }
                    }
                    if (previousRowIndex !== rowIndex) {
                        previousStageStart = stage.startCycle;
                        previousStageEnd = endCycle;
                    } else {
                        previousStageEnd = Math.max(previousStageEnd, endCycle);
                    }
                    previousRowIndex = rowIndex;
                    const row = rows[rowIndex];
                    if (stage.startCycle >= 0 && stage.startCycle < cycleCount) {
                        row.startCount++;
                    }
                    if (workSinceYield >= yieldInterval) {
                        await yieldToBrowser();
                        workSinceYield = 0;
                        if (options.isCanceled?.()) {
                            return null;
                        }
                    }
                }
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

    const allocationDetection = stageStructureDetector.finish().allocation;
    const allocationReference = allocationDetection === null
        ? null
        : buildAllocationReference(
            allocationDetection,
            rows,
            rowIndices,
            transitionCounts,
            transitionLatencies,
        );
    const analysis = allocationReference === null
        ? null
        : await classifyTopDownSlots(
            trace,
            allocationReference,
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

function isAllocatedSlot(slotClass: TopDownSlotClass): boolean {
    return slotClass === TopDownSlotClass.RETIRING ||
        slotClass === TopDownSlotClass.SQUASHED ||
        slotClass === TopDownSlotClass.UNRESOLVED;
}

function growLiveSlots(
    analysis: Readonly<TopDownAnalysis>,
    cycleCount: number,
): TopDownAnalysis | null {
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

function addLiveAllocatedSlot(
    analysis: Readonly<TopDownAnalysis>,
    cycle: number,
    slotClass: TopDownSlotClass,
): void {
    const firstSlot = Math.floor(cycle) * analysis.allocationWidth;
    const endSlot = firstSlot + analysis.allocationWidth;
    if (firstSlot < 0 || endSlot > analysis.slots.length) {
        return;
    }
    for (let index = firstSlot; index < endSlot; index++) {
        if (!isAllocatedSlot(analysis.slots[index] as TopDownSlotClass)) {
            analysis.slots[index] = slotClass;
            return;
        }
    }
}

function markLiveBackend(
    analysis: Readonly<TopDownAnalysis>,
    startCycle: number,
    endCycle: number,
): void {
    const capacity = Math.floor(analysis.slots.length / analysis.allocationWidth);
    const firstCycle = Math.max(0, Math.min(capacity, Math.floor(startCycle)));
    const lastCycle = Math.max(firstCycle, Math.min(capacity, Math.ceil(endCycle)));
    for (let cycle = firstCycle; cycle < lastCycle; cycle++) {
        const firstSlot = cycle * analysis.allocationWidth;
        const endSlot = firstSlot + analysis.allocationWidth;
        for (let index = firstSlot; index < endSlot; index++) {
            if (analysis.slots[index] === TopDownSlotClass.FRONTEND_BOUND) {
                analysis.slots[index] = TopDownSlotClass.BACKEND_BOUND;
            }
        }
    }
}

/** 確定済みのstage構造を使い、Parserが新たに公開したOpだけをslotへ反映する。 */
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
    const addOp = (op: Readonly<Op>): void => {
        if (op.eof) {
            return;
        }
        const { firstAllocationCycle } = observeAllocationStages(
            op,
            analysis.allocationStage.laneID,
            analysis.allocationStage.stageName,
            analysis.executionStage.stageName,
            admissionByStage,
            (startCycle, endCycle) => {
                markLiveBackend(analysis, startCycle, endCycle);
            },
        );
        if (firstAllocationCycle === null) {
            return;
        }
        const slotClass = op.retired
            ? TopDownSlotClass.RETIRING
            : op.flush
                ? TopDownSlotClass.SQUASHED
                : TopDownSlotClass.UNRESOLVED;
        addLiveAllocatedSlot(analysis, firstAllocationCycle, slotClass);
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

    let retiringSlots = 0;
    let squashedSlots = 0;
    let recoveryBubbleSlots = 0;
    let unresolvedSlots = 0;
    let frontendBound = 0;
    let backendBound = 0;
    let sampledCycleCount = 0;
    for (let cycle = sampleCycle; cycle < lastCycle; cycle += samplingStride) {
        const firstSlot = cycle * allocationWidth;
        const lastSlot = firstSlot + allocationWidth;
        for (let slot = firstSlot; slot < lastSlot; slot++) {
            switch (analysis.slots[slot]) {
            case TopDownSlotClass.RETIRING:
                retiringSlots++;
                break;
            case TopDownSlotClass.SQUASHED:
                squashedSlots++;
                break;
            case TopDownSlotClass.RECOVERY_BUBBLE:
                recoveryBubbleSlots++;
                break;
            case TopDownSlotClass.FRONTEND_BOUND:
                frontendBound++;
                break;
            case TopDownSlotClass.BACKEND_BOUND:
                backendBound++;
                break;
            case TopDownSlotClass.UNRESOLVED:
                unresolvedSlots++;
                break;
            }
        }
        sampledCycleCount++;
    }
    const totalSlots = sampledCycleCount * allocationWidth;
    return {
        analysis,
        startCycle: firstCycle,
        endCycle: lastCycle,
        totalSlots,
        retiringSlots,
        squashedSlots,
        recoveryBubbleSlots,
        unresolvedSlots,
        frontendBound,
        backendBound,
        sampledCycleCount,
        samplingStride,
    };
}
