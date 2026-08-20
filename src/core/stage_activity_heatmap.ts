/**
 * Stage activityのデータ集計とCanvas描画を実装する。
 *
 * `buildStageActivity()`はParsedTraceだけを読み、ReactやCanvasを知らない集計層である。
 * `drawStageActivityHeatmap()`は集計済みのStageActivityDataだけを描き、Traceを再走査しない。
 * 表示設定、構築のcancel、Canvasの所有はTraceSheetが担い、既存のpipeline Rendererと
 * 独立した小さな2D Canvasとして保つ。
 */
import type { ParsedTrace } from "./model";
import {
    getKonataZoomScale,
    KONATA_OP_WIDTH,
    type KonataRenderSpec,
    type RendererTheme,
} from "./konata_renderer";

// fsで読むと配布後のcurrent directoryに依存するため、pipeline Rendererと同じthemeを
// moduleとして取り込む。ヒートマップはstageを表すため、既定のUnique配色だけを使う。
import darkStyle from "../../theme/dark/style.json";
import lightStyle from "../../theme/light/style.json";

const DEFAULT_MAX_CELL_COUNT = 1024 * 1024;
const DEFAULT_YIELD_INTERVAL = 50_000;
// Top-down breakdownはcycle単位で分類してから表示binへ集約する。巨大traceで一時配列が
// stage heatmap本体より大きくならないよう、試作中は厳密解析へ上限を設ける。
const MAX_EXACT_TOP_DOWN_CYCLE_COUNT = 4 * 1024 * 1024;
// 1件だけの短い外れ値をpipeline固有の最短回復時間としない。通常の分岐回復なら
// 同じcycle数が繰り返し現れるため、十分な反復を持つ最小bucketだけを採用する。
const MIN_SUPPORTED_RECOVERY_SAMPLE_COUNT = 10;

export type StageActivityScale = "stage" | "global";
export type StageActivityMetric = "active" | "starts" | "topdown";

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

export interface StageActivityRow {
    readonly laneID: number;
    readonly laneName: string;
    readonly stageName: string;
    readonly label: string;
    readonly uniqueLevel: number;
    readonly lanePosition: number;
    // 各binの平均occupancyを累積した配列。区間平均を画面pixelごとにO(1)で求める。
    readonly totalPrefix: Float32Array;
    readonly flushedPrefix: Float32Array;
    readonly totalPeak: number;
    readonly nonFlushedPeak: number;
    // stage開始件数のprefix。rateは区間cycle数で割って求める。
    readonly totalStartsPrefix: Uint32Array;
    readonly flushedStartsPrefix: Uint32Array;
    readonly totalStartPeak: number;
    readonly nonFlushedStartPeak: number;
}

export interface StageTopDownAnalysis {
    readonly allocationRowIndex: number;
    readonly executionRowIndex: number;
    readonly allocationWidth: number;
    readonly transitionCount: number;
    readonly transitionCoverage: number;
    readonly admissionRows: readonly StageAllocationAdmissionRow[];
    readonly mispredictionWindowCount: number;
    readonly minimumRecoveryCycles: number | null;
    readonly minimumRecoverySampleCount: number;
    readonly retiringPrefix: Float64Array;
    readonly squashedPrefix: Float64Array;
    readonly mispredictionShadowPrefix: Float64Array;
    readonly unresolvedPrefix: Float64Array;
    readonly frontendPrefix: Float64Array;
    readonly backendPrefix: Float64Array;
}

export interface StageAllocationAdmissionRow {
    readonly rowIndex: number;
    readonly typicalLatency: number;
    readonly transitionCount: number;
}

export interface StageActivityData {
    readonly cycleCount: number;
    readonly binWidth: number;
    readonly binCount: number;
    readonly rows: readonly StageActivityRow[];
    readonly totalPeak: number;
    readonly nonFlushedPeak: number;
    readonly totalStartPeak: number;
    readonly nonFlushedStartPeak: number;
    readonly topDownAnalysis: Readonly<StageTopDownAnalysis> | null;
}

export interface StageActivitySample {
    readonly row: Readonly<StageActivityRow>;
    readonly startCycle: number;
    readonly endCycle: number;
    readonly activity: number;
    readonly startCount: number;
    readonly startRate: number;
    readonly activePeak: number;
    readonly startPeak: number;
    readonly rowPeak: number;
    readonly globalPeak: number;
    readonly relativeLevel: number;
    readonly peakShare: number;
}

export interface StageTopDownBreakdownSample {
    readonly analysis: Readonly<StageTopDownAnalysis>;
    readonly allocationRow: Readonly<StageActivityRow>;
    readonly executionRow: Readonly<StageActivityRow>;
    readonly startCycle: number;
    readonly endCycle: number;
    readonly totalSlots: number;
    readonly retiringSlots: number;
    readonly squashedSlots: number;
    readonly mispredictionShadowSlots: number;
    readonly unresolvedSlots: number;
    readonly frontendBound: number;
    readonly backendBound: number;
}

export interface StageActivityBuildOptions {
    readonly maxCellCount?: number;
    readonly yieldInterval?: number;
    readonly isCanceled?: () => boolean;
}

interface MutableActivityRow {
    readonly laneID: number;
    readonly laneName: string;
    readonly stageName: string;
    readonly label: string;
    readonly uniqueLevel: number;
    readonly lanePosition: number;
    readonly totalDiff: Float32Array;
    readonly totalPartial: Float32Array;
    readonly flushedDiff: Float32Array;
    readonly flushedPartial: Float32Array;
    readonly totalStarts: Uint32Array;
    readonly flushedStarts: Uint32Array;
}

function createRows(
    trace: ParsedTrace,
    binCount: number,
): {
    readonly rows: MutableActivityRow[];
    readonly rowIndices: ReadonlyMap<number, ReadonlyMap<string, number>>;
} {
    const rows: MutableActivityRow[] = [];
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
                laneID,
                laneName,
                stageName,
                label: showLaneName ? `${laneName}/${stageName}` : stageName,
                uniqueLevel: trace.stageLevelMap.get(laneName, stageName)?.unique ?? 0,
                lanePosition: trace.stageLevelMap.getLanePosition(laneID),
                totalDiff: new Float32Array(binCount + 1),
                totalPartial: new Float32Array(binCount),
                flushedDiff: new Float32Array(binCount + 1),
                flushedPartial: new Float32Array(binCount),
                totalStarts: new Uint32Array(binCount + 1),
                flushedStarts: new Uint32Array(binCount + 1),
            });
        }
    }
    return { rows, rowIndices };
}

function addInterval(
    diff: Float32Array,
    partial: Float32Array,
    binWidth: number,
    cycleCount: number,
    startCycle: number,
    endCycle: number,
): void {
    const start = Math.max(0, Math.min(cycleCount, startCycle));
    const end = Math.max(0, Math.min(cycleCount, endCycle));
    if (end <= start) {
        return;
    }

    const firstBin = Math.floor(start / binWidth);
    const lastBin = Math.ceil(end / binWidth) - 1;
    const firstBinDuration = Math.min(cycleCount, (firstBin + 1) * binWidth) -
        firstBin * binWidth;
    if (firstBin === lastBin) {
        partial[firstBin] += (end - start) / firstBinDuration;
        return;
    }

    const lastBinDuration = Math.min(cycleCount, (lastBin + 1) * binWidth) -
        lastBin * binWidth;
    partial[firstBin] += ((firstBin + 1) * binWidth - start) / firstBinDuration;
    partial[lastBin] += (end - lastBin * binWidth) / lastBinDuration;
    if (firstBin + 1 < lastBin) {
        diff[firstBin + 1]++;
        diff[lastBin]--;
    }
}

function addStart(
    starts: Uint32Array,
    binWidth: number,
    cycleCount: number,
    startCycle: number,
): void {
    if (startCycle < 0 || startCycle >= cycleCount) {
        return;
    }
    starts[Math.floor(startCycle / binWidth) + 1]++;
}

function finishRow(
    row: MutableActivityRow,
    binWidth: number,
    cycleCount: number,
): {
    readonly totalPrefix: Float32Array;
    readonly flushedPrefix: Float32Array;
    readonly totalPeak: number;
    readonly nonFlushedPeak: number;
    readonly totalStartsPrefix: Uint32Array;
    readonly flushedStartsPrefix: Uint32Array;
    readonly totalStartPeak: number;
    readonly nonFlushedStartPeak: number;
} {
    let totalActive = row.totalDiff[0];
    let flushedActive = row.flushedDiff[0];
    let totalCumulative = 0;
    let flushedCumulative = 0;
    let totalPeak = 0;
    let nonFlushedPeak = 0;
    let totalStartsCumulative = 0;
    let flushedStartsCumulative = 0;
    let totalStartPeak = 0;
    let nonFlushedStartPeak = 0;
    row.totalDiff[0] = 0;
    row.flushedDiff[0] = 0;
    for (let bin = 0; bin < row.totalPartial.length; bin++) {
        const nextTotalDelta = row.totalDiff[bin + 1];
        const nextFlushedDelta = row.flushedDiff[bin + 1];
        const total = totalActive + row.totalPartial[bin];
        const flushed = flushedActive + row.flushedPartial[bin];
        const totalStarts = row.totalStarts[bin + 1];
        const flushedStarts = row.flushedStarts[bin + 1];
        const binDuration = Math.min(cycleCount, (bin + 1) * binWidth) - bin * binWidth;
        totalPeak = Math.max(totalPeak, total);
        nonFlushedPeak = Math.max(nonFlushedPeak, total - flushed);
        totalCumulative += total;
        flushedCumulative += flushed;
        row.totalDiff[bin + 1] = totalCumulative;
        row.flushedDiff[bin + 1] = flushedCumulative;
        totalStartsCumulative += totalStarts;
        flushedStartsCumulative += flushedStarts;
        row.totalStarts[bin + 1] = totalStartsCumulative;
        row.flushedStarts[bin + 1] = flushedStartsCumulative;
        totalStartPeak = Math.max(totalStartPeak, totalStarts / binDuration);
        nonFlushedStartPeak = Math.max(
            nonFlushedStartPeak,
            (totalStarts - flushedStarts) / binDuration,
        );
        totalActive += nextTotalDelta;
        flushedActive += nextFlushedDelta;
    }
    return {
        totalPrefix: row.totalDiff,
        flushedPrefix: row.flushedDiff,
        totalPeak,
        nonFlushedPeak,
        totalStartsPrefix: row.totalStarts,
        flushedStartsPrefix: row.flushedStarts,
        totalStartPeak,
        nonFlushedStartPeak,
    };
}

type StageTransitionCounts = ReadonlyMap<number, ReadonlyMap<number, number>>;
type StageTransitionLatencies = ReadonlyMap<
    number,
    ReadonlyMap<number, ReadonlyMap<number, number>>
>;

interface StageAllocationReference {
    readonly allocationRowIndex: number;
    readonly executionRowIndex: number;
    readonly transitionCount: number;
    readonly transitionCoverage: number;
    readonly admissionRows: readonly StageAllocationAdmissionRow[];
}

interface TopDownOpRecord {
    readonly flush: boolean;
    readonly retired: boolean;
    readonly isControlFlow: boolean;
    readonly allocationCycle: number | null;
    readonly completionCycle: number | null;
}

interface MispredictionWindow {
    readonly startCycle: number;
    readonly completionCycle: number;
    nextCorrectAllocationCycle: number | null;
    valid: boolean;
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
    const latencies = [...histogram.keys()].sort((left, right) => left - right);
    for (const latency of latencies) {
        const sampleCount = histogram.get(latency) ?? 0;
        if (sampleCount >= MIN_SUPPORTED_RECOVERY_SAMPLE_COUNT) {
            return { value: latency, sampleCount };
        }
    }
    return null;
}

function inferAllocationReference(
    rows: readonly StageActivityRow[],
    transitions: StageTransitionCounts,
    transitionLatencies: StageTransitionLatencies,
): StageAllocationReference | null {
    let best: {
        readonly reference: StageAllocationReference;
        readonly score: number;
    } | null = null;
    for (const [allocationRowIndex, successors] of transitions) {
        let executionRowIndex = -1;
        let transitionCount = 0;
        for (const [candidateIndex, count] of successors) {
            if (count > transitionCount) {
                executionRowIndex = candidateIndex;
                transitionCount = count;
            }
        }
        const allocationRow = rows[allocationRowIndex];
        const executionRow = rows[executionRowIndex];
        // 終端stageへの遷移はROBからretireへの流れである可能性が高いため候補から外す。
        // 残る候補のうち、最も大きな滞留を受けるstageをbackend入口の自動推定とする。
        // 後続stageは入口より後のexecution側であることを確認するためだけに使う。
        if (allocationRow === undefined || executionRow === undefined ||
            (transitions.get(executionRowIndex)?.size ?? 0) === 0 ||
            allocationRow.totalPeak <= 0 || allocationRow.totalStartPeak <= 0) {
            continue;
        }
        const allocationStarts = allocationRow.totalStartsPrefix[
            allocationRow.totalStartsPrefix.length - 1
        ];
        const transitionCoverage = allocationStarts === 0
            ? 0
            : Math.min(1, transitionCount / allocationStarts);
        const reference = {
            allocationRowIndex,
            executionRowIndex,
            transitionCount,
            transitionCoverage,
            admissionRows: [] as readonly StageAllocationAdmissionRow[],
        };
        const score = allocationRow.totalPeak * transitionCoverage;
        if (best === null || score > best.score ||
            (score === best.score && transitionCount > best.reference.transitionCount)) {
            best = { reference, score };
        }
    }
    if (best === null) {
        return null;
    }
    const allocationRowIndex = best.reference.allocationRowIndex;
    const admissionRows: StageAllocationAdmissionRow[] = [];
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
        admissionRows.push({ rowIndex, typicalLatency, transitionCount: count });
    }
    admissionRows.sort((left, right) =>
        right.transitionCount - left.transitionCount || left.rowIndex - right.rowIndex);
    return { ...best.reference, admissionRows };
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

async function buildStageTopDownAnalysis(
    trace: ParsedTrace,
    rows: readonly StageActivityRow[],
    reference: Readonly<StageAllocationReference>,
    cycleCount: number,
    binWidth: number,
    binCount: number,
    yieldInterval: number,
    isCanceled?: () => boolean,
): Promise<StageTopDownAnalysis | null> {
    if (cycleCount > MAX_EXACT_TOP_DOWN_CYCLE_COUNT) {
        return null;
    }
    const allocationRow = rows[reference.allocationRowIndex];
    const executionRow = rows[reference.executionRowIndex];
    if (allocationRow === undefined || executionRow === undefined) {
        return null;
    }

    const retiringStarts = new Uint32Array(cycleCount);
    const squashedStarts = new Uint32Array(cycleCount);
    const unresolvedStarts = new Uint32Array(cycleCount);
    const backendAdmissionDiff = new Int32Array(cycleCount + 1);
    const flushedAdmissionDiff = new Int32Array(cycleCount + 1);
    const previousOpByThread = new Map<number, Readonly<TopDownOpRecord>>();
    const pendingWindowByThread = new Map<number, MispredictionWindow>();
    const mispredictionWindows: MispredictionWindow[] = [];
    const recoveryLatencyHistogram = new Map<number, number>();
    // O3PipeViewにallocation-side recovery eventはないため、以下はPMU TMAの厳密な
    // 復元ではなく、後にflushと分かった命令列から作る事後的な因果分類である。
    const admissionRowsByStage = new Map<string, Readonly<StageAllocationAdmissionRow>>();
    for (const admission of reference.admissionRows) {
        const row = rows[admission.rowIndex];
        if (row !== undefined && row.laneID === allocationRow.laneID) {
            admissionRowsByStage.set(row.stageName, admission);
        }
    }
    let workSinceYield = 0;
    for (let id = 0; id <= trace.lastID; id++) {
        if (isCanceled?.()) {
            return null;
        }
        const op = trace.getOpForScan(id);
        if (op === undefined) {
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
                        // 後にflushされる命令の停滞は、有効な仕事を早めないため別に保持する。
                        addExactInterval(
                            op.flush ? flushedAdmissionDiff : backendAdmissionDiff,
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
        const previous = previousOpByThread.get(tid);
        if (op.flush) {
            if (previous !== undefined && !previous.flush && previous.retired &&
                previous.isControlFlow && previous.allocationCycle !== null &&
                previous.completionCycle !== null &&
                previous.completionCycle > previous.allocationCycle) {
                // 同じthreadで連続するflush列の直前にあるretiring control-flow命令だけを
                // 原因候補とする。明示cause eventがない形式では、これ以上広い推定をしない。
                const window: MispredictionWindow = {
                    startCycle: previous.allocationCycle,
                    completionCycle: previous.completionCycle,
                    nextCorrectAllocationCycle: null,
                    valid: true,
                };
                mispredictionWindows.push(window);
                pendingWindowByThread.set(tid, window);
            }
        } else {
            const pendingWindow = pendingWindowByThread.get(tid);
            if (pendingWindow !== undefined) {
                pendingWindowByThread.delete(tid);
                if (op.retired && firstAllocationCycle !== null &&
                    firstAllocationCycle >= pendingWindow.completionCycle) {
                    pendingWindow.nextCorrectAllocationCycle = firstAllocationCycle;
                    const latency = Math.floor(
                        firstAllocationCycle - pendingWindow.completionCycle,
                    );
                    recoveryLatencyHistogram.set(
                        latency,
                        (recoveryLatencyHistogram.get(latency) ?? 0) + 1,
                    );
                } else {
                    // cause対応が正しければ、flush後のcorrect allocationが原因命令の
                    // Completeより前へ来ることはない。矛盾する候補はshadow自体に使わない。
                    pendingWindow.valid = false;
                }
            }
        }
        previousOpByThread.set(tid, {
            flush: op.flush,
            retired: op.retired,
            isControlFlow: isLikelyControlFlowLabel(op.labelName),
            allocationCycle: firstAllocationCycle,
            completionCycle,
        });

        workSinceYield++;
        if (workSinceYield >= yieldInterval) {
            await yieldToBrowser();
            workSinceYield = 0;
            if (isCanceled?.()) {
                return null;
            }
        }
    }
    let allocationWidth = 0;
    for (let cycle = 0; cycle < cycleCount; cycle++) {
        allocationWidth = Math.max(
            allocationWidth,
            retiringStarts[cycle] + squashedStarts[cycle] + unresolvedStarts[cycle],
        );
    }
    if (allocationWidth <= 0) {
        return null;
    }

    const supportedRecovery = getSupportedMinimum(recoveryLatencyHistogram);
    const mispredictionDiff = new Int32Array(cycleCount + 1);
    let mispredictionWindowCount = 0;
    for (const window of mispredictionWindows) {
        if (!window.valid) {
            continue;
        }
        let endCycle = window.completionCycle;
        if (supportedRecovery !== null && window.nextCorrectAllocationCycle !== null) {
            // 実際のcorrect allocationより先へは延ばさない。長いI-cache／ITLB待ちは
            // supported minimumを超えた時点から従来のFrontend／Backend判定へ戻す。
            endCycle = Math.min(
                window.nextCorrectAllocationCycle,
                window.completionCycle + supportedRecovery.value,
            );
        }
        addExactInterval(mispredictionDiff, cycleCount, window.startCycle, endCycle);
        mispredictionWindowCount++;
    }

    const retiringPrefix = new Float64Array(binCount + 1);
    const squashedPrefix = new Float64Array(binCount + 1);
    const mispredictionShadowPrefix = new Float64Array(binCount + 1);
    const unresolvedPrefix = new Float64Array(binCount + 1);
    const frontendPrefix = new Float64Array(binCount + 1);
    const backendPrefix = new Float64Array(binCount + 1);
    let backendAdmissionDepth = 0;
    let flushedAdmissionDepth = 0;
    let mispredictionDepth = 0;
    for (let cycle = 0; cycle < cycleCount; cycle++) {
        backendAdmissionDepth += backendAdmissionDiff[cycle];
        flushedAdmissionDepth += flushedAdmissionDiff[cycle];
        mispredictionDepth += mispredictionDiff[cycle];
        const retired = retiringStarts[cycle];
        const squashed = squashedStarts[cycle];
        const unresolved = unresolvedStarts[cycle];
        const allocated = retired + squashed + unresolved;
        const unused = Math.max(0, allocationWidth - allocated);
        addBinValue(retiringPrefix, binWidth, cycle, retired);
        addBinValue(squashedPrefix, binWidth, cycle, squashed);
        addBinValue(unresolvedPrefix, binWidth, cycle, unresolved);
        if (flushedAdmissionDepth > 0) {
            // 入口で止まった命令自体が後にflushされるなら、その停滞を解消しても
            // wrong-path処理が増えるだけなので、空きslotもBad Speculationへ入れる。
            addBinValue(mispredictionShadowPrefix, binWidth, cycle, unused);
        } else if (backendAdmissionDepth > 0) {
            // 後段queueに命令があるだけではBackendにしない。TMA Level 1はexecution
            // issueではなくallocationを観測するため、入口で実際に止まった場合だけを
            // Backend backpressureとする。retire／未確定命令の停滞だけがここへ来る。
            addBinValue(backendPrefix, binWidth, cycle, unused);
        } else if (mispredictionDepth > 0) {
            // 事後的に予測ミスと確定した区間では、Frontend供給を増やしても
            // correct-path命令はallocateできない。残余slotだけをshadowへ移す。
            addBinValue(mispredictionShadowPrefix, binWidth, cycle, unused);
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
        mispredictionShadowPrefix,
        unresolvedPrefix,
        frontendPrefix,
        backendPrefix,
    ].forEach(finishPrefix);
    return {
        ...reference,
        allocationWidth,
        mispredictionWindowCount,
        minimumRecoveryCycles: supportedRecovery?.value ?? null,
        minimumRecoverySampleCount: supportedRecovery?.sampleCount ?? 0,
        retiringPrefix,
        squashedPrefix,
        mispredictionShadowPrefix,
        unresolvedPrefix,
        frontendPrefix,
        backendPrefix,
    };
}

/**
 * 集計層: Traceからstageごとの平均active命令数と開始rateを作る。
 *
 * Active、Starts、Top-down-likeの全てを一度で構築し、metric切替時はこの結果を再利用する。
 * cell数を固定上限へ収め、短いTraceは1 cycle/bin、長いTraceは自動的に粗粒度化する。
 * 呼出し側はViewを閉じた時やTraceを破棄する時にisCanceledをtrueへする。
 */
export async function buildStageActivity(
    trace: ParsedTrace,
    options: Readonly<StageActivityBuildOptions> = {},
): Promise<StageActivityData | null> {
    const stageCount = trace.stageLevelMap.laneNames.reduce(
        (count, laneName) => count + trace.stageLevelMap.getStageNames(laneName).length,
        0,
    );
    const cycleCount = Math.max(1, Math.ceil(trace.lastCycle));
    const maxCellCount = Math.max(stageCount, options.maxCellCount ?? DEFAULT_MAX_CELL_COUNT);
    const maxBinCount = Math.max(1, Math.floor(maxCellCount / Math.max(1, stageCount)));
    const binWidth = Math.max(1, Math.ceil(cycleCount / maxBinCount));
    const binCount = Math.max(1, Math.ceil(cycleCount / binWidth));
    const { rows, rowIndices } = createRows(trace, binCount);
    if (rows.length === 0) {
        return {
            cycleCount,
            binWidth,
            binCount,
            rows: [],
            totalPeak: 0,
            nonFlushedPeak: 0,
            totalStartPeak: 0,
            nonFlushedStartPeak: 0,
            topDownAnalysis: null,
        };
    }

    const yieldInterval = Math.max(1, options.yieldInterval ?? DEFAULT_YIELD_INTERVAL);
    const transitionCounts = new Map<number, Map<number, number>>();
    const transitionLatencies = new Map<number, Map<number, Map<number, number>>>();
    let workSinceYield = 0;
    for (let id = 0; id <= trace.lastID; id++) {
        if (options.isCanceled?.()) {
            return null;
        }
        const op = trace.getOpForScan(id);
        if (op !== undefined) {
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
                    addStart(row.totalStarts, binWidth, cycleCount, stage.startCycle);
                    addInterval(
                        row.totalDiff,
                        row.totalPartial,
                        binWidth,
                        cycleCount,
                        stage.startCycle,
                        endCycle,
                    );
                    if (op.flush) {
                        addStart(row.flushedStarts, binWidth, cycleCount, stage.startCycle);
                        addInterval(
                            row.flushedDiff,
                            row.flushedPartial,
                            binWidth,
                            cycleCount,
                            stage.startCycle,
                            endCycle,
                        );
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

    const finishedRows = rows.map((row): StageActivityRow => {
        const finished = finishRow(row, binWidth, cycleCount);
        return {
            laneID: row.laneID,
            laneName: row.laneName,
            stageName: row.stageName,
            label: row.label,
            uniqueLevel: row.uniqueLevel,
            lanePosition: row.lanePosition,
            ...finished,
        };
    });
    const allocationReference = inferAllocationReference(
        finishedRows,
        transitionCounts,
        transitionLatencies,
    );
    const topDownAnalysis = allocationReference === null
        ? null
        : await buildStageTopDownAnalysis(
            trace,
            finishedRows,
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
        rows: finishedRows,
        totalPeak: finishedRows.reduce((peak, row) => Math.max(peak, row.totalPeak), 0),
        nonFlushedPeak: finishedRows.reduce(
            (peak, row) => Math.max(peak, row.nonFlushedPeak),
            0,
        ),
        totalStartPeak: finishedRows.reduce(
            (peak, row) => Math.max(peak, row.totalStartPeak),
            0,
        ),
        nonFlushedStartPeak: finishedRows.reduce(
            (peak, row) => Math.max(peak, row.nonFlushedStartPeak),
            0,
        ),
        topDownAnalysis,
    };
}

function prefixAt(
    prefix: Float32Array | Float64Array | Uint32Array,
    position: number,
): number {
    const binCount = prefix.length - 1;
    const clipped = Math.max(0, Math.min(binCount, position));
    const bin = Math.min(binCount - 1, Math.floor(clipped));
    if (bin < 0 || clipped === binCount) {
        return prefix[binCount] ?? 0;
    }
    const fraction = clipped - bin;
    return prefix[bin] + (prefix[bin + 1] - prefix[bin]) * fraction;
}

export function getStageActivityAverage(
    row: Readonly<StageActivityRow>,
    binWidth: number,
    startCycle: number,
    endCycle: number,
    hideFlushedOps: boolean,
): number {
    if (endCycle <= startCycle) {
        return 0;
    }
    const start = startCycle / binWidth;
    const end = endCycle / binWidth;
    const total = prefixAt(row.totalPrefix, end) - prefixAt(row.totalPrefix, start);
    const flushed = hideFlushedOps
        ? prefixAt(row.flushedPrefix, end) - prefixAt(row.flushedPrefix, start)
        : 0;
    return Math.max(0, (total - flushed) / (end - start));
}

export function getStageStartCount(
    row: Readonly<StageActivityRow>,
    binWidth: number,
    startCycle: number,
    endCycle: number,
    hideFlushedOps: boolean,
): number {
    if (endCycle <= startCycle) {
        return 0;
    }
    const start = startCycle / binWidth;
    const end = endCycle / binWidth;
    const total = prefixAt(row.totalStartsPrefix, end) -
        prefixAt(row.totalStartsPrefix, start);
    const flushed = hideFlushedOps
        ? prefixAt(row.flushedStartsPrefix, end) -
            prefixAt(row.flushedStartsPrefix, start)
        : 0;
    return Math.max(0, total - flushed);
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

function getStageTopDownBreakdown(
    data: Readonly<StageActivityData>,
    startCycle: number,
    endCycle: number,
): StageTopDownBreakdownSample | null {
    const analysis = data.topDownAnalysis;
    if (analysis === null || endCycle <= startCycle) {
        return null;
    }
    const allocationRow = data.rows[analysis.allocationRowIndex];
    const executionRow = data.rows[analysis.executionRowIndex];
    if (allocationRow === undefined || executionRow === undefined || analysis.allocationWidth <= 0) {
        return null;
    }
    const retiringSlots = getRawPrefixCount(
        analysis.retiringPrefix, data.binWidth, startCycle, endCycle,
    );
    const squashedSlots = getRawPrefixCount(
        analysis.squashedPrefix, data.binWidth, startCycle, endCycle,
    );
    const mispredictionShadowSlots = getRawPrefixCount(
        analysis.mispredictionShadowPrefix, data.binWidth, startCycle, endCycle,
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
    const totalSlots = retiringSlots + squashedSlots + mispredictionShadowSlots + unresolvedSlots +
        frontendBound + backendBound;
    return {
        analysis,
        allocationRow,
        executionRow,
        startCycle,
        endCycle,
        totalSlots,
        retiringSlots,
        squashedSlots,
        mispredictionShadowSlots,
        unresolvedSlots,
        frontendBound,
        backendBound,
    };
}

export function getStageTopDownBreakdownSample(
    data: Readonly<StageActivityData>,
    spec: Readonly<KonataRenderSpec>,
    x: number,
    width: number,
): StageTopDownBreakdownSample | null {
    if (x < 0 || x >= width) {
        return null;
    }
    const opWidth = KONATA_OP_WIDTH * getKonataZoomScale(spec.zoomLevel);
    const cycle = spec.position[0] + x / opWidth;
    if (cycle < 0 || cycle >= data.cycleCount) {
        return null;
    }
    const bin = Math.min(data.binCount - 1, Math.floor(cycle / data.binWidth));
    const startCycle = bin * data.binWidth;
    return getStageTopDownBreakdown(
        data,
        startCycle,
        Math.min(data.cycleCount, startCycle + data.binWidth),
    );
}

export function getStageStartRate(
    row: Readonly<StageActivityRow>,
    binWidth: number,
    startCycle: number,
    endCycle: number,
    hideFlushedOps: boolean,
): number {
    return endCycle <= startCycle
        ? 0
        : getStageStartCount(row, binWidth, startCycle, endCycle, hideFlushedOps) /
            (endCycle - startCycle);
}

export function getStageActivityPeak(
    row: Readonly<StageActivityRow>,
    hideFlushedOps: boolean,
): number {
    return hideFlushedOps ? row.nonFlushedPeak : row.totalPeak;
}

export function getStageActivityGlobalPeak(
    data: Readonly<StageActivityData>,
    hideFlushedOps: boolean,
): number {
    return hideFlushedOps ? data.nonFlushedPeak : data.totalPeak;
}

export function getStageStartPeak(
    row: Readonly<StageActivityRow>,
    hideFlushedOps: boolean,
): number {
    return hideFlushedOps ? row.nonFlushedStartPeak : row.totalStartPeak;
}

export function getStageStartGlobalPeak(
    data: Readonly<StageActivityData>,
    hideFlushedOps: boolean,
): number {
    return hideFlushedOps ? data.nonFlushedStartPeak : data.totalStartPeak;
}

function getStageMetricValue(
    row: Readonly<StageActivityRow>,
    metric: StageActivityMetric,
    binWidth: number,
    startCycle: number,
    endCycle: number,
    hideFlushedOps: boolean,
): number {
    return metric === "active"
        ? getStageActivityAverage(row, binWidth, startCycle, endCycle, hideFlushedOps)
        : getStageStartRate(row, binWidth, startCycle, endCycle, hideFlushedOps);
}

function getStageMetricPeak(
    row: Readonly<StageActivityRow>,
    metric: StageActivityMetric,
    hideFlushedOps: boolean,
): number {
    return metric === "active"
        ? getStageActivityPeak(row, hideFlushedOps)
        : getStageStartPeak(row, hideFlushedOps);
}

function getStageMetricGlobalPeak(
    data: Readonly<StageActivityData>,
    metric: StageActivityMetric,
    hideFlushedOps: boolean,
): number {
    return metric === "active"
        ? getStageActivityGlobalPeak(data, hideFlushedOps)
        : getStageStartGlobalPeak(data, hideFlushedOps);
}

export function getStageActivitySample(
    data: Readonly<StageActivityData>,
    spec: Readonly<KonataRenderSpec>,
    metric: StageActivityMetric,
    x: number,
    y: number,
    width: number,
    height: number,
): StageActivitySample | null {
    if (data.rows.length === 0 || x < 0 || x >= width || y < 0 || y >= height) {
        return null;
    }
    const rowHeight = height / data.rows.length;
    const row = data.rows[Math.min(data.rows.length - 1, Math.floor(y / rowHeight))];
    const opWidth = KONATA_OP_WIDTH * getKonataZoomScale(spec.zoomLevel);
    const cycle = spec.position[0] + x / opWidth;
    if (cycle < 0 || cycle >= data.cycleCount) {
        return null;
    }
    const bin = Math.min(data.binCount - 1, Math.floor(cycle / data.binWidth));
    const startCycle = bin * data.binWidth;
    const endCycle = Math.min(data.cycleCount, startCycle + data.binWidth);
    const activity = getStageActivityAverage(
        row,
        data.binWidth,
        startCycle,
        endCycle,
        spec.hideFlushedOps,
    );
    const startCount = getStageStartCount(
        row,
        data.binWidth,
        startCycle,
        endCycle,
        spec.hideFlushedOps,
    );
    const startRate = startCount / (endCycle - startCycle);
    const activePeak = getStageActivityPeak(row, spec.hideFlushedOps);
    const startPeak = getStageStartPeak(row, spec.hideFlushedOps);
    const selectedValue = metric === "active" ? activity : startRate;
    const rowPeak = getStageMetricPeak(row, metric, spec.hideFlushedOps);
    const globalPeak = getStageMetricGlobalPeak(data, metric, spec.hideFlushedOps);
    return {
        row,
        startCycle,
        endCycle,
        activity,
        startCount,
        startRate,
        activePeak,
        startPeak,
        rowPeak,
        globalPeak,
        relativeLevel: rowPeak === 0 ? 0 : selectedValue / rowPeak,
        peakShare: globalPeak === 0 ? 0 : rowPeak / globalPeak,
    };
}

interface CanvasSize {
    readonly width: number;
    readonly height: number;
}

function prepareCanvas(canvas: HTMLCanvasElement): CanvasSize {
    const width = Math.max(1, canvas.clientWidth);
    const height = Math.max(1, canvas.clientHeight);
    const pixelRatio = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;
    const backingWidth = Math.max(1, Math.round(width * pixelRatio));
    const backingHeight = Math.max(1, Math.round(height * pixelRatio));
    if (canvas.width !== backingWidth || canvas.height !== backingHeight) {
        canvas.width = backingWidth;
        canvas.height = backingHeight;
    }
    const context = canvas.getContext("2d");
    if (context === null) {
        throw new Error("A 2D canvas context is required to draw stage activity.");
    }
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    return { width, height };
}

function getUniqueStageColors(
    row: Readonly<StageActivityRow>,
    theme: RendererTheme,
): readonly [string, string] {
    const style = theme === "light" ? lightStyle : darkStyle;
    if (row.stageName === "f" || row.stageName === "stl") {
        return [style.pipelinePane.stallBackgroundColor, style.pipelinePane.stallBackgroundColor];
    }
    const color = style.pipelinePane.stageBackgroundColor;
    const makeColor = (begin: boolean) => {
        const rate = Number(begin ? color.hRateBegin : color.hRateEnd);
        const saturation = Number(begin ? color.sBegin : color.sEnd);
        const lightness = Number(begin ? color.lBegin : color.lEnd);
        const hue = (250 - row.uniqueLevel * rate + row.lanePosition * 28 * 8 + 3600) % 360;
        return `hsl(${hue},${saturation}%,${lightness}%)`;
    };
    return [makeColor(true), makeColor(false)];
}

interface TopDownBreakdownColors {
    readonly retiring: string;
    readonly badSpeculation: string;
    readonly unresolved: string;
    readonly frontendBound: string;
    readonly backendBound: string;
}

function getTopDownBreakdownColors(theme: RendererTheme): TopDownBreakdownColors {
    // Top-down categoryはstageではないため、stage paletteから独立したsemantic colorを使う。
    return theme === "light"
        ? {
            retiring: "#2e7d32",
            badSpeculation: "#c62828",
            frontendBound: "#1565c0",
            backendBound: "#ef6c00",
            unresolved: "#616161",
        }
        : {
            retiring: "#66bb6a",
            badSpeculation: "#ef5350",
            frontendBound: "#42a5f5",
            backendBound: "#ffa726",
            unresolved: "#b0bec5",
        };
}

function drawTopDownBreakdownInterval(
    context: CanvasRenderingContext2D,
    sample: Readonly<StageTopDownBreakdownSample>,
    colors: Readonly<TopDownBreakdownColors>,
    left: number,
    width: number,
    height: number,
): void {
    if (sample.totalSlots <= 0) {
        return;
    }
    const segments = [
        [sample.retiringSlots, colors.retiring],
        [sample.squashedSlots + sample.mispredictionShadowSlots, colors.badSpeculation],
        [sample.frontendBound, colors.frontendBound],
        [sample.backendBound, colors.backendBound],
        [sample.unresolvedSlots, colors.unresolved],
    ] as const;
    let top = 0;
    for (const [value, color] of segments) {
        const segmentHeight = height * value / sample.totalSlots;
        if (segmentHeight > 0) {
            context.globalAlpha = 1;
            context.fillStyle = color;
            context.fillRect(left, top, width, segmentHeight);
        }
        top += segmentHeight;
    }
}

function drawStageTopDownBreakdown(
    data: Readonly<StageActivityData>,
    spec: Readonly<KonataRenderSpec>,
    labelContext: CanvasRenderingContext2D,
    heatmapContext: CanvasRenderingContext2D,
    labelSize: Readonly<CanvasSize>,
    heatmapSize: Readonly<CanvasSize>,
): void {
    const analysis = data.topDownAnalysis;
    const colors = getTopDownBreakdownColors(spec.theme);
    const style = spec.theme === "light" ? lightStyle : darkStyle;
    const margin = Number(style.labelPane.marginLeft);
    labelContext.font = `${style.fontStyle} 12px ${style.fontFamily}`;
    labelContext.textAlign = "left";
    labelContext.textBaseline = "middle";
    labelContext.fillStyle = style.labelPane.fontColor;
    labelContext.globalAlpha = 1;
    if (analysis === null) {
        labelContext.fillText("Top-down-like view unavailable", margin, 18);
        labelContext.fillText("No allocation boundary was inferred for this trace.", margin, 38);
        return;
    }
    const allocationRow = data.rows[analysis.allocationRowIndex];
    const executionRow = data.rows[analysis.executionRowIndex];
    const format = (value: number) => Number.isInteger(value)
        ? value.toString()
        : value.toFixed(1);
    const averaged = data.binWidth === 1 ? "" : ` (${data.binWidth}-cycle avg)`;
    labelContext.fillText("Top-down-like (auto)", margin, 13);
    labelContext.fillText(
        `Allocation ${allocationRow.label} · width ≥${format(analysis.allocationWidth)}/c${averaged}`,
        margin,
        31,
    );
    const admissionLabel = analysis.admissionRows.slice(0, 2).map((admission) => {
        const row = data.rows[admission.rowIndex];
        return row === undefined ? "" : `${row.label} +${format(admission.typicalLatency)}c`;
    }).filter((label) => label.length > 0).join(", ");
    const entrance = admissionLabel.length === 0 ? "" : ` · entrance ${admissionLabel}`;
    const shadow = analysis.mispredictionWindowCount === 0
        ? ""
        : analysis.minimumRecoveryCycles === null
            ? ` · shadow ${analysis.mispredictionWindowCount}`
            : ` · shadow ${analysis.mispredictionWindowCount}, +${format(analysis.minimumRecoveryCycles)}c min`;
    labelContext.fillText(
        `Before ${executionRow.label}${entrance}${shadow} · ${(analysis.transitionCoverage * 100).toFixed(0)}% links`,
        margin,
        49,
    );
    const legends = [
        ["Retiring", colors.retiring],
        ["Bad speculation", colors.badSpeculation],
        ["Frontend bound", colors.frontendBound],
        ["Backend bound", colors.backendBound],
        ["Unresolved", colors.unresolved],
    ] as const;
    const columnWidth = Math.max(100, (labelSize.width - margin * 2) / 3);
    legends.forEach(([label, color], index) => {
        const column = index % 3;
        const row = Math.floor(index / 3);
        const left = margin + column * columnWidth;
        const center = 72 + row * 22;
        labelContext.globalAlpha = 1;
        labelContext.fillStyle = color;
        labelContext.fillRect(left, center - 5, 10, 10);
        labelContext.globalAlpha = 1;
        labelContext.fillStyle = style.labelPane.fontColor;
        labelContext.fillText(label, left + 15, center, columnWidth - 18);
    });

    const opWidth = KONATA_OP_WIDTH * getKonataZoomScale(spec.zoomLevel);
    const leftCycle = spec.position[0];
    const rightCycle = leftCycle + heatmapSize.width / opWidth;
    const binPixelWidth = data.binWidth * opWidth;
    if (binPixelWidth >= 1) {
        const firstBin = Math.max(0, Math.floor(leftCycle / data.binWidth));
        const lastBin = Math.min(data.binCount, Math.ceil(rightCycle / data.binWidth));
        for (let bin = firstBin; bin < lastBin; bin++) {
            const startCycle = bin * data.binWidth;
            const endCycle = Math.min(data.cycleCount, startCycle + data.binWidth);
            const sample = getStageTopDownBreakdown(data, startCycle, endCycle);
            if (sample === null) {
                continue;
            }
            const left = Math.max(0, (startCycle - leftCycle) * opWidth);
            const right = Math.min(heatmapSize.width, (endCycle - leftCycle) * opWidth);
            drawTopDownBreakdownInterval(
                heatmapContext,
                sample,
                colors,
                left,
                Math.max(1, right - left),
                heatmapSize.height,
            );
        }
    } else {
        for (let x = 0; x < heatmapSize.width; x++) {
            const startCycle = Math.max(0, leftCycle + x / opWidth);
            const endCycle = Math.min(data.cycleCount, leftCycle + (x + 1) / opWidth);
            const sample = getStageTopDownBreakdown(data, startCycle, endCycle);
            if (sample !== null) {
            drawTopDownBreakdownInterval(
                    heatmapContext,
                    sample,
                    colors,
                    x,
                    1,
                    heatmapSize.height,
                );
            }
        }
    }
    labelContext.globalAlpha = 1;
    heatmapContext.globalAlpha = 1;
}

function drawActivityRow(
    context: CanvasRenderingContext2D,
    data: Readonly<StageActivityData>,
    row: Readonly<StageActivityRow>,
    spec: Readonly<KonataRenderSpec>,
    rowTop: number,
    rowHeight: number,
    width: number,
    metric: StageActivityMetric,
    scale: StageActivityScale,
): void {
    const opWidth = KONATA_OP_WIDTH * getKonataZoomScale(spec.zoomLevel);
    const leftCycle = spec.position[0];
    const rightCycle = leftCycle + width / opWidth;
    const [beginColor, endColor] = getUniqueStageColors(row, spec.theme);
    const gradient = context.createLinearGradient(0, rowTop, 0, rowTop + rowHeight);
    gradient.addColorStop(0, beginColor);
    gradient.addColorStop(1, endColor);
    context.fillStyle = gradient;
    const scalePeak = scale === "stage"
        ? getStageMetricPeak(row, metric, spec.hideFlushedOps)
        : getStageMetricGlobalPeak(data, metric, spec.hideFlushedOps);
    if (scalePeak <= 0) {
        return;
    }

    const binPixelWidth = data.binWidth * opWidth;
    if (binPixelWidth >= 1) {
        const firstBin = Math.max(0, Math.floor(leftCycle / data.binWidth));
        const lastBin = Math.min(data.binCount, Math.ceil(rightCycle / data.binWidth));
        for (let bin = firstBin; bin < lastBin; bin++) {
            const startCycle = bin * data.binWidth;
            const endCycle = Math.min(data.cycleCount, startCycle + data.binWidth);
            const value = getStageMetricValue(
                row,
                metric,
                data.binWidth,
                startCycle,
                endCycle,
                spec.hideFlushedOps,
            );
            if (value <= 0) {
                continue;
            }
            const left = Math.max(0, (startCycle - leftCycle) * opWidth);
            const right = Math.min(width, (endCycle - leftCycle) * opWidth);
            context.globalAlpha = Math.min(1, value / scalePeak);
            context.fillRect(left, rowTop, Math.max(1, right - left), rowHeight);
        }
        return;
    }

    // 多数のbinが1 pixelへ潰れる倍率では、prefixからpixel区間平均を直接引く。
    for (let x = 0; x < width; x++) {
        const startCycle = leftCycle + x / opWidth;
        const endCycle = leftCycle + (x + 1) / opWidth;
        const value = getStageMetricValue(
            row,
            metric,
            data.binWidth,
            startCycle,
            endCycle,
            spec.hideFlushedOps,
        );
        if (value <= 0) {
            continue;
        }
        context.globalAlpha = Math.min(1, value / scalePeak);
        context.fillRect(x, rowTop, 1, rowHeight);
    }
}

/**
 * 描画層: 集計済みdataを、既存pipeline Rendererから独立したCanvasへ描く。
 *
 * specのcycle位置とzoomを使うことで上のpipelineと横軸を揃える。ここでTraceや
 * Storeは参照せず、metricやscaleの切替は再集計ではなく再描画だけで反映する。
 */
export function drawStageActivityHeatmap(
    data: Readonly<StageActivityData>,
    spec: Readonly<KonataRenderSpec>,
    labelCanvas: HTMLCanvasElement,
    heatmapCanvas: HTMLCanvasElement,
    metric: StageActivityMetric,
    scale: StageActivityScale,
): void {
    const labelSize = prepareCanvas(labelCanvas);
    const heatmapSize = prepareCanvas(heatmapCanvas);
    const labelContext = labelCanvas.getContext("2d");
    const heatmapContext = heatmapCanvas.getContext("2d");
    if (labelContext === null || heatmapContext === null) {
        return;
    }
    const style = spec.theme === "light" ? lightStyle : darkStyle;
    labelContext.globalAlpha = 1;
    labelContext.fillStyle = style.labelPane.backgroundColor;
    labelContext.fillRect(0, 0, labelSize.width, labelSize.height);
    heatmapContext.globalAlpha = 1;
    heatmapContext.fillStyle = style.pipelinePane.backgroundColor;
    heatmapContext.fillRect(0, 0, heatmapSize.width, heatmapSize.height);
    if (data.rows.length === 0) {
        return;
    }
    if (metric === "topdown") {
        drawStageTopDownBreakdown(
            data,
            spec,
            labelContext,
            heatmapContext,
            labelSize,
            heatmapSize,
        );
        return;
    }

    const rowHeight = heatmapSize.height / data.rows.length;
    const fontSize = Math.max(7, Math.min(Number(style.fontSize), rowHeight - 3));
    labelContext.font = `${style.fontStyle} ${fontSize}px ${style.fontFamily}`;
    labelContext.fillStyle = style.labelPane.fontColor;
    labelContext.textBaseline = "middle";
    const margin = Number(style.labelPane.marginLeft);
    const globalPeak = getStageMetricGlobalPeak(data, metric, spec.hideFlushedOps);
    for (let index = 0; index < data.rows.length; index++) {
        const row = data.rows[index];
        const top = index * rowHeight;
        const rowPeak = getStageMetricPeak(row, metric, spec.hideFlushedOps);
        const peakShare = globalPeak === 0 ? 0 : rowPeak / globalPeak;
        if (rowHeight >= 8) {
            labelContext.globalAlpha = 1;
            labelContext.fillStyle = style.labelPane.fontColor;
            labelContext.textAlign = "left";
            labelContext.fillText(
                row.label,
                margin,
                top + rowHeight / 2,
                Math.max(1, labelSize.width - margin * 2 - 62),
            );
            if (labelSize.width >= 120) {
                const peakText = Number.isInteger(rowPeak)
                    ? `peak ${rowPeak}${metric === "starts" ? "/c" : ""}`
                    : `peak ${rowPeak.toFixed(1)}${metric === "starts" ? "/c" : ""}`;
                labelContext.textAlign = "right";
                labelContext.fillText(peakText, labelSize.width - margin, top + rowHeight / 2);
            }
        }
        if (rowHeight >= 5) {
            const barWidth = Math.max(0, labelSize.width - margin * 2);
            labelContext.globalAlpha = 0.16;
            labelContext.fillStyle = style.labelPane.fontColor;
            labelContext.fillRect(margin, top + rowHeight - 2, barWidth, 2);
            labelContext.globalAlpha = 0.9;
            labelContext.fillStyle = getUniqueStageColors(row, spec.theme)[0];
            labelContext.fillRect(margin, top + rowHeight - 2, barWidth * peakShare, 2);
        }
        drawActivityRow(
            heatmapContext,
            data,
            row,
            spec,
            top,
            rowHeight,
            heatmapSize.width,
            metric,
            scale,
        );
    }
    labelContext.globalAlpha = 1;
    labelContext.textAlign = "left";
    heatmapContext.globalAlpha = 1;
}
