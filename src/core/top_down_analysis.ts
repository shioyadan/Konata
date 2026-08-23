/**
 * ParsedTraceからTop-down-likeのslot分類を構築する。UIやCanvasには依存しない。
 */
import {
    type DetectedAllocationStage,
    StageStructureDetector,
} from "./stage_structure_detector";
import type { ParsedTrace } from "./model";

const DEFAULT_MAX_BIN_COUNT = 128 * 1024;
const DEFAULT_YIELD_INTERVAL = 50_000;
// Top-down breakdownはcycle単位で分類してから表示binへ集約する。巨大traceで一時配列が
// stage heatmap本体より大きくならないよう、試作中は厳密解析へ上限を設ける。
const MAX_EXACT_TOP_DOWN_CYCLE_COUNT = 4 * 1024 * 1024;
// 1件だけの短い外れ値をpipeline固有の最短回復時間としない。通常の分岐回復なら
// 同じcycle数が繰り返し現れるため、十分な反復を持つ最小bucketだけを採用する。
const MIN_SUPPORTED_RECOVERY_SAMPLE_COUNT = 10;

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
    readonly retiringPrefix: Float64Array;
    readonly squashedPrefix: Float64Array;
    readonly recoveryBubblePrefix: Float64Array;
    readonly unresolvedPrefix: Float64Array;
    readonly frontendPrefix: Float64Array;
    readonly backendPrefix: Float64Array;
}

export interface TopDownAdmission {
    readonly stage: TopDownStage;
    readonly typicalLatency: number;
}

export interface TopDownData {
    readonly cycleCount: number;
    readonly binWidth: number;
    readonly binCount: number;
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
}

export interface TopDownBuildOptions {
    readonly maxBinCount?: number;
    readonly yieldInterval?: number;
    readonly isCanceled?: () => boolean;
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

function addExactStart(starts: Uint32Array, cycleCount: number, cycle: number): void {
    const integerCycle = Math.floor(cycle);
    if (integerCycle >= 0 && integerCycle < cycleCount) {
        starts[integerCycle]++;
    }
}

function addBinValue(values: Float64Array, binWidth: number, cycle: number, value: number): void {
    if (value > 0) {
        values[Math.floor(cycle / binWidth) + 1] += value;
    }
}

function finishPrefix(prefix: Float64Array): void {
    for (let index = 1; index < prefix.length; index++) {
        prefix[index] += prefix[index - 1];
    }
}

async function classifyTopDownSlots(
    trace: ParsedTrace,
    reference: Readonly<StageAllocationReference>,
    cycleCount: number,
    binWidth: number,
    binCount: number,
    yieldInterval: number,
    isCanceled?: () => boolean,
): Promise<TopDownAnalysis | null> {
    if (cycleCount > MAX_EXACT_TOP_DOWN_CYCLE_COUNT) {
        return null;
    }
    const { allocationRow, executionRow } = reference;

    const retiringStarts = new Uint32Array(cycleCount);
    const squashedStarts = new Uint32Array(cycleCount);
    const unresolvedStarts = new Uint32Array(cycleCount);
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
    for (let id = 0; id <= trace.lastID; id++) {
        if (isCanceled?.()) {
            return null;
        }
        const op = trace.getOpForScan(id);
        if (op === undefined || op.eof) {
            continue;
        }
        const allocationLane = op.lanes[allocationRow.laneID];
        let firstAllocationCycle: number | null = null;
        let completionCycle: number | null = null;
        if (allocationLane !== null && allocationLane !== undefined) {
            let previousStageName: string | null = null;
            let previousStageStart = 0;
            let previousStageEnd = 0;
            let executionSeen = false;
            for (const stage of allocationLane.stages) {
                const endCycle = stage.endCycle === 0 ? op.retiredCycle : stage.endCycle;
                if (stage.name !== previousStageName) {
                    const admission = previousStageName === null
                        ? undefined
                        : admissionRowsByStage.get(previousStageName);
                    if (stage.name === allocationRow.stageName && admission !== undefined) {
                        // allocation直前のstageに通常より長く留まった区間を入口停滞とする。
                        // 命令が後にflushされても、resolution前の空きslotはrecoveryではない。
                        addExactInterval(
                            backendAdmissionDiff,
                            cycleCount,
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
                if (stage.name === allocationRow.stageName) {
                    firstAllocationCycle = firstAllocationCycle === null
                        ? stage.startCycle
                        : Math.min(firstAllocationCycle, stage.startCycle);
                }
                if (stage.name === executionRow.stageName) {
                    executionSeen = true;
                } else if (executionSeen && completionCycle === null) {
                    // executionの直後に始まるstageを、stage名に依存しないComplete proxyにする。
                    completionCycle = stage.startCycle;
                }
            }
        }
        if (firstAllocationCycle !== null) {
            // TMA Level 1のslotはexecution issueではなく、FrontendからBackendへuopを
            // 渡すallocation pointで数える。同じ命令が後段でreplayしても1 slotのままにする。
            const target = op.retired
                ? retiringStarts
                : op.flush
                    ? squashedStarts
                    : unresolvedStarts;
            addExactStart(target, cycleCount, firstAllocationCycle);
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
    const allocationWidth = reference.allocationWidth;

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

    const retiringPrefix = new Float64Array(binCount + 1);
    const squashedPrefix = new Float64Array(binCount + 1);
    const recoveryBubblePrefix = new Float64Array(binCount + 1);
    const unresolvedPrefix = new Float64Array(binCount + 1);
    const frontendPrefix = new Float64Array(binCount + 1);
    const backendPrefix = new Float64Array(binCount + 1);
    let backendAdmissionDepth = 0;
    let recoveryDepth = 0;
    for (let cycle = 0; cycle < cycleCount; cycle++) {
        backendAdmissionDepth += backendAdmissionDiff[cycle];
        recoveryDepth += recoveryDiff[cycle];
        const retired = retiringStarts[cycle];
        const squashed = squashedStarts[cycle];
        const unresolved = unresolvedStarts[cycle];
        const allocated = retired + squashed + unresolved;
        const unused = Math.max(0, allocationWidth - allocated);
        addBinValue(retiringPrefix, binWidth, cycle, retired);
        addBinValue(squashedPrefix, binWidth, cycle, squashed);
        addBinValue(unresolvedPrefix, binWidth, cycle, unresolved);
        if (recoveryDepth > 0) {
            // resolution後にcorrect pathがallocate可能になるまでの空きslotは、TMAの
            // recovery bubbleに相当する。ただし反復観測した最短回復時間を上限とする。
            addBinValue(recoveryBubblePrefix, binWidth, cycle, unused);
        } else if (backendAdmissionDepth > 0) {
            // 後段queueに命令があるだけではBackendにしない。TMA Level 1はexecution
            // issueではなくallocationを観測するため、入口で実際に止まった場合だけを
            // Backend backpressureとする。最終的にflushされる命令もresolution前は含む。
            addBinValue(backendPrefix, binWidth, cycle, unused);
        } else {
            addBinValue(frontendPrefix, binWidth, cycle, unused);
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
    [
        retiringPrefix,
        squashedPrefix,
        recoveryBubblePrefix,
        unresolvedPrefix,
        frontendPrefix,
        backendPrefix,
    ].forEach(finishPrefix);
    return {
        allocationStage: {
            stageName: allocationRow.stageName,
            label: allocationRow.label,
        },
        executionStage: {
            stageName: executionRow.stageName,
            label: executionRow.label,
        },
        allocationWidth,
        transitionCoverage: reference.transitionCoverage,
        admissionStages: reference.admissionRows.map((admission) => {
            return {
                stage: {
                    stageName: admission.row.stageName,
                    label: admission.row.label,
                },
                typicalLatency: admission.typicalLatency,
            };
        }),
        recoveryWindowCount,
        minimumRecoveryCycles: supportedRecovery?.value ?? null,
        minimumRecoverySampleCount: supportedRecovery?.sampleCount ?? 0,
        retiringPrefix,
        squashedPrefix,
        recoveryBubblePrefix,
        unresolvedPrefix,
        frontendPrefix,
        backendPrefix,
    };
}

/**
 * 集計層: TraceからTop-down-like表示に必要なstage構造とslot分類を作る。
 *
 * bin数を固定上限へ収め、短いTraceは1 cycle/bin、長いTraceは自動的に粗粒度化する。
 * 呼出し側はViewを閉じた時やTraceを破棄する時にisCanceledをtrueへする。
 */
export async function buildTopDownData(
    trace: ParsedTrace,
    options: Readonly<TopDownBuildOptions> = {},
): Promise<TopDownData | null> {
    const cycleCount = Math.max(1, Math.ceil(trace.lastCycle));
    const maxBinCount = Math.max(1, options.maxBinCount ?? DEFAULT_MAX_BIN_COUNT);
    const binWidth = Math.max(1, Math.ceil(cycleCount / maxBinCount));
    const binCount = Math.max(1, Math.ceil(cycleCount / binWidth));
    const { rows, rowIndices } = createRows(trace);
    if (rows.length === 0) {
        return {
            cycleCount,
            binWidth,
            binCount,
            analysis: null,
        };
    }

    const yieldInterval = Math.max(1, options.yieldInterval ?? DEFAULT_YIELD_INTERVAL);
    const stageStructureDetector = new StageStructureDetector();
    const transitionCounts = new Map<number, Map<number, number>>();
    const transitionLatencies = new Map<number, Map<number, Map<number, number>>>();
    let workSinceYield = 0;
    for (let id = 0; id <= trace.lastID; id++) {
        if (options.isCanceled?.()) {
            return null;
        }
        const op = trace.getOpForScan(id);
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
            binWidth,
            binCount,
            yieldInterval,
            options.isCanceled,
        );
    if (options.isCanceled?.()) {
        return null;
    }
    return {
        cycleCount,
        binWidth,
        binCount,
        analysis,
    };
}

function prefixAt(prefix: Float64Array, position: number): number {
    const binCount = prefix.length - 1;
    const clipped = Math.max(0, Math.min(binCount, position));
    const bin = Math.min(binCount - 1, Math.floor(clipped));
    if (bin < 0 || clipped === binCount) {
        return prefix[binCount] ?? 0;
    }
    const fraction = clipped - bin;
    return prefix[bin] + (prefix[bin + 1] - prefix[bin]) * fraction;
}

function getRawPrefixCount(
    prefix: Float64Array,
    binWidth: number,
    startCycle: number,
    endCycle: number,
): number {
    if (endCycle <= startCycle) {
        return 0;
    }
    return Math.max(
        0,
        prefixAt(prefix, endCycle / binWidth) - prefixAt(prefix, startCycle / binWidth),
    );
}

export function getTopDownBreakdown(
    data: Readonly<TopDownData>,
    startCycle: number,
    endCycle: number,
): TopDownBreakdown | null {
    const analysis = data.analysis;
    if (analysis === null || endCycle <= startCycle) {
        return null;
    }
    if (analysis.allocationWidth <= 0) {
        return null;
    }
    const retiringSlots = getRawPrefixCount(
        analysis.retiringPrefix, data.binWidth, startCycle, endCycle,
    );
    const squashedSlots = getRawPrefixCount(
        analysis.squashedPrefix, data.binWidth, startCycle, endCycle,
    );
    const recoveryBubbleSlots = getRawPrefixCount(
        analysis.recoveryBubblePrefix, data.binWidth, startCycle, endCycle,
    );
    const unresolvedSlots = getRawPrefixCount(
        analysis.unresolvedPrefix, data.binWidth, startCycle, endCycle,
    );
    const frontendBound = getRawPrefixCount(
        analysis.frontendPrefix, data.binWidth, startCycle, endCycle,
    );
    const backendBound = getRawPrefixCount(
        analysis.backendPrefix, data.binWidth, startCycle, endCycle,
    );
    const totalSlots = retiringSlots + squashedSlots + recoveryBubbleSlots + unresolvedSlots +
        frontendBound + backendBound;
    return {
        analysis,
        startCycle,
        endCycle,
        totalSlots,
        retiringSlots,
        squashedSlots,
        recoveryBubbleSlots,
        unresolvedSlots,
        frontendBound,
        backendBound,
    };
}
