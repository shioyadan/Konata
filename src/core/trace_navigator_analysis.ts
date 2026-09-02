/** ParsedTraceからcycle方向NavigatorのactivityとTop-down-like分類を構築する。 */
import {
    createCycleActivity,
    getCycleActivity,
    getCycleActivityByteLength,
    growCycleActivity,
    incrementCycleActivity,
    sealCycleActivity,
    setCycleLatency,
    TRACE_NAVIGATOR_BIN_CYCLE_COUNT,
    type CycleActivity,
    type CycleActivityMode,
    type CycleActivitySample,
} from "./cycle_activity_analysis";
import type { Op, ParsedTrace } from "./model";
import {
    type DetectedStage,
    type DetectedStageGroup,
    type DetectedStageObservation,
    type DetectedStageStructure,
    StageStructureDetector,
} from "./stage_structure_detector";

const DEFAULT_YIELD_INTERVAL = 50_000;
const MAX_EXACT_CYCLE_COUNT = 4 * 1024 * 1024;
const MAX_WORKING_BYTES = 128 * 1024 * 1024;
const SLOT_CLASS_COUNT = 6;
const MIN_SUPPORTED_RECOVERY_SAMPLE_COUNT = 10;
export const CYCLE_NAVIGATOR_INITIAL_SNAPSHOT_OP_COUNT = 50_000;

const enum SlotClass {
    RETIRING,
    SQUASHED,
    RECOVERY_BUBBLE,
    FRONTEND_BOUND,
    BACKEND_BOUND,
    UNRESOLVED,
}

interface NavigatorStage {
    readonly laneID: number;
    readonly stageName: string;
    readonly label: string;
}

interface TopDownAnalysis {
    // 検出済み構造はlive更新でだけ使い、RendererやSheetには解釈させない。
    readonly structure: Readonly<DetectedStageStructure>;
    readonly allocationStage: NavigatorStage;
    readonly executionStage: NavigatorStage;
    readonly allocationWidth: number;
    readonly transitionCoverage: number;
    readonly admissionStages: readonly {
        readonly stage: NavigatorStage;
        readonly typicalLatency: number;
    }[];
    readonly recoveryWindowCount: number;
    readonly minimumRecoveryCycles: number | null;
    readonly minimumRecoverySampleCount: number;
    readonly slotCounts: Uint16Array;
    readonly tailSlots: Uint8Array;
}

export interface CycleNavigatorData {
    readonly cycleCount: number;
    // このcycleより前は、公開済みOpのstage／lifecycle情報が揃っている。
    readonly confirmedCycle: number;
    // exact tailには表示境界より後のcommit等も保持するため、別に観測終端を持つ。
    readonly observedCycleCount: number;
    readonly sourceLastID: number;
    readonly cycleActivity: CycleActivity;
    readonly topDown: TopDownAnalysis | null;
}

export interface CycleNavigatorTopDownSample {
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

export interface CycleNavigatorBuildOptions {
    readonly yieldInterval?: number;
    readonly isCanceled?: () => boolean;
    readonly live?: boolean;
    readonly binCycleCount?: number;
}

export type CycleNavigatorMode = "top-down" | CycleActivityMode;

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

function formatStage(trace: ParsedTrace, stage: Readonly<DetectedStage>): NavigatorStage {
    const showLaneName = trace.stageLevelMap.laneNum > 1;
    const laneName = trace.stageLevelMap.getLaneName(stage.laneID);
    const label = showLaneName && laneName !== undefined
        ? `${laneName}/${stage.stageName}`
        : stage.stageName;
    return { ...stage, label };
}

function formatStageGroup(
    trace: ParsedTrace,
    group: Readonly<DetectedStageGroup>,
): NavigatorStage {
    return formatStage(trace, {
        laneID: group.laneID,
        stageName: group.stageNames.join("/"),
    });
}

function isLikelyControlFlowLabel(labelName: string): boolean {
    // flush列との動的な関係を主な根拠とし、mnemonicはclearの誤対応を防ぐgateにする。
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
    for (const [value, sampleCount] of histogram) {
        if (sampleCount >= MIN_SUPPORTED_RECOVERY_SAMPLE_COUNT &&
            (supported === null || value < supported.value)) {
            supported = { value, sampleCount };
        }
    }
    return supported;
}

function isAllocated(slotClass: SlotClass): boolean {
    return slotClass === SlotClass.RETIRING ||
        slotClass === SlotClass.SQUASHED ||
        slotClass === SlotClass.UNRESOLVED;
}

function addAllocatedSlot(
    slots: Uint8Array,
    sealedCycle: number,
    width: number,
    cycle: number,
    slotClass: SlotClass,
): void {
    const first = (Math.floor(cycle) - sealedCycle) * width;
    const end = first + width;
    if (!Number.isFinite(first) || first < 0 || end > slots.length) {
        return;
    }
    for (let index = first; index < end; index++) {
        if (!isAllocated(slots[index] as SlotClass)) {
            slots[index] = slotClass;
            return;
        }
    }
}

function markEmptySlots(
    slots: Uint8Array,
    sealedCycle: number,
    width: number,
    startCycle: number,
    endCycle: number,
    slotClass: SlotClass,
): void {
    const capacity = Math.floor(slots.length / width);
    const first = Math.max(0, Math.min(capacity, Math.floor(startCycle) - sealedCycle));
    const end = Math.max(first, Math.min(capacity, Math.ceil(endCycle) - sealedCycle));
    for (let cycle = first; cycle < end; cycle++) {
        for (let index = cycle * width; index < (cycle + 1) * width; index++) {
            const current = slots[index] as SlotClass;
            if (!isAllocated(current) &&
                (slotClass !== SlotClass.BACKEND_BOUND ||
                    current === SlotClass.FRONTEND_BOUND)) {
                slots[index] = slotClass;
            }
        }
    }
}

function getOpSlotClass(op: Readonly<Op>): SlotClass {
    return op.retired
        ? SlotClass.RETIRING
        : op.flush
            ? SlotClass.SQUASHED
            : SlotClass.UNRESOLVED;
}

/** Detectorの観測値だけをslotへ反映し、stage名や遷移は再解釈しない。 */
function observeTopDown(
    analysis: Readonly<TopDownAnalysis>,
    op: Readonly<Op>,
    sealedCycle: number,
): DetectedStageObservation {
    const observation = analysis.structure.observe(op);
    if (observation.admissionStallStartCycle !== null &&
        observation.admissionStallEndCycle !== null) {
        markEmptySlots(
            analysis.tailSlots,
            sealedCycle,
            analysis.allocationWidth,
            observation.admissionStallStartCycle,
            observation.admissionStallEndCycle,
            SlotClass.BACKEND_BOUND,
        );
    }
    if (observation.allocationCycle !== null) {
        addAllocatedSlot(
            analysis.tailSlots,
            sealedCycle,
            analysis.allocationWidth,
            observation.allocationCycle,
            getOpSlotClass(op),
        );
    }
    return observation;
}

function observeLifecycle(op: Readonly<Op>, activity: CycleActivity): void {
    if (op.eof) {
        return;
    }
    incrementCycleActivity(activity, "fetch", op.fetchedCycle, op.flush);
    if (op.retired) {
        incrementCycleActivity(activity, "commit", op.retiredCycle);
    }
}

function observeDetectedActivity(
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

/** 三回目のsample走査でslot分類、stage依存activity、recovery統計を同時に作る。 */
async function buildTopDown(
    trace: ParsedTrace,
    structure: Readonly<DetectedStageStructure>,
    activity: CycleActivity,
    cycleCount: number,
    lastID: number,
    yieldInterval: number,
    isCanceled?: () => boolean,
): Promise<TopDownAnalysis | null> {
    const width = structure.allocationStage.width;
    const slotCount = cycleCount * width;
    if (cycleCount > MAX_EXACT_CYCLE_COUNT || !Number.isSafeInteger(slotCount) ||
        width * activity.binCycleCount > 0xffff ||
        slotCount + getCycleActivityByteLength(activity) > MAX_WORKING_BYTES) {
        return null;
    }
    const tailSlots = new Uint8Array(slotCount);
    tailSlots.fill(SlotClass.FRONTEND_BOUND);
    const analysis: TopDownAnalysis = {
        structure,
        allocationStage: formatStageGroup(trace, structure.allocationStage),
        executionStage: formatStageGroup(trace, structure.executionStage),
        allocationWidth: width,
        transitionCoverage: structure.transitionCoverage,
        admissionStages: structure.admissionStages.map((admission) => ({
            stage: formatStage(trace, admission),
            typicalLatency: admission.typicalLatency,
        })),
        recoveryWindowCount: 0,
        minimumRecoveryCycles: null,
        minimumRecoverySampleCount: 0,
        slotCounts: new Uint16Array(0),
        tailSlots,
    };
    const previousRecoveryStart = new Map<number, number>();
    const pendingRecoveryStart = new Map<number, number>();
    const recoveryWindows: Array<readonly [number, number]> = [];
    const recoveryLatencies = new Map<number, number>();
    let recoveryWindowCount = 0;
    let workSinceYield = 0;

    for (let id = 0; id <= lastID; id++) {
        if (isCanceled?.()) {
            return null;
        }
        const op = trace.getOpForScan(id);
        if (op === undefined || op.eof) {
            continue;
        }
        const observation = observeTopDown(analysis, op, 0);
        observeDetectedActivity(op, observation, activity);

        const tid = op.tid;
        const previous = previousRecoveryStart.get(tid);
        if (op.flush) {
            if (previous !== undefined) {
                pendingRecoveryStart.set(tid, previous);
                recoveryWindowCount++;
            }
        } else {
            const recoveryStart = pendingRecoveryStart.get(tid);
            if (recoveryStart !== undefined) {
                pendingRecoveryStart.delete(tid);
                if (op.retired && observation.allocationCycle !== null &&
                    observation.allocationCycle >= recoveryStart) {
                    recoveryWindows.push([recoveryStart, observation.allocationCycle]);
                    const latency = Math.floor(observation.allocationCycle - recoveryStart);
                    recoveryLatencies.set(latency, (recoveryLatencies.get(latency) ?? 0) + 1);
                } else {
                    recoveryWindowCount--;
                }
            }
        }
        previousRecoveryStart.delete(tid);
        if (!op.flush && op.retired && observation.allocationCycle !== null &&
            observation.completionCycle !== null &&
            observation.completionCycle > observation.allocationCycle &&
            isLikelyControlFlowLabel(op.labelName)) {
            previousRecoveryStart.set(tid, observation.completionCycle);
        }

        if (++workSinceYield >= yieldInterval) {
            await yieldToBrowser();
            workSinceYield = 0;
        }
    }

    const supportedRecovery = getSupportedMinimum(recoveryLatencies);
    if (supportedRecovery !== null) {
        for (const [startCycle, correctAllocationCycle] of recoveryWindows) {
            markEmptySlots(
                tailSlots,
                0,
                width,
                startCycle,
                Math.min(correctAllocationCycle, startCycle + supportedRecovery.value),
                SlotClass.RECOVERY_BUBBLE,
            );
        }
    }
    return {
        ...analysis,
        recoveryWindowCount,
        minimumRecoveryCycles: supportedRecovery?.value ?? null,
        minimumRecoverySampleCount: supportedRecovery?.sampleCount ?? 0,
    };
}

function growTopDown(
    analysis: Readonly<TopDownAnalysis>,
    sealedCycle: number,
    cycleCapacity: number,
): TopDownAnalysis | null {
    const required = Math.max(1, cycleCapacity - sealedCycle);
    const current = Math.floor(analysis.tailSlots.length / analysis.allocationWidth);
    if (required <= current) {
        return analysis;
    }
    const capacity = Math.max(required, current * 2);
    if (capacity > MAX_EXACT_CYCLE_COUNT) {
        return null;
    }
    const tailSlots = new Uint8Array(capacity * analysis.allocationWidth);
    tailSlots.fill(SlotClass.FRONTEND_BOUND);
    tailSlots.set(analysis.tailSlots);
    return { ...analysis, tailSlots };
}

function growCounts(values: Uint16Array, required: number): Uint16Array {
    if (values.length >= required) {
        return values;
    }
    const grown = new Uint16Array(values.length === 0
        ? required
        : Math.max(required, values.length * 2));
    grown.set(values);
    return grown;
}

function sealTopDown(
    analysis: Readonly<TopDownAnalysis>,
    sealedCycle: number,
    nextSealedCycle: number,
    cycleCount: number,
    binCycleCount: number,
): TopDownAnalysis {
    if (nextSealedCycle <= sealedCycle) {
        return analysis;
    }
    const { allocationWidth: width } = analysis;
    const firstBin = sealedCycle / binCycleCount;
    const sealedBinCount = nextSealedCycle / binCycleCount;
    const slotCounts = growCounts(analysis.slotCounts, sealedBinCount * SLOT_CLASS_COUNT);
    for (let bin = firstBin; bin < sealedBinCount; bin++) {
        const firstCycle = (bin - firstBin) * binCycleCount;
        const firstCount = bin * SLOT_CLASS_COUNT;
        for (let cycle = firstCycle; cycle < firstCycle + binCycleCount; cycle++) {
            for (let slot = cycle * width; slot < (cycle + 1) * width; slot++) {
                slotCounts[firstCount + analysis.tailSlots[slot]]++;
            }
        }
    }
    const removedSlots = (nextSealedCycle - sealedCycle) * width;
    const tailSlots = new Uint8Array(Math.max(1, cycleCount - nextSealedCycle) * width);
    tailSlots.fill(SlotClass.FRONTEND_BOUND);
    tailSlots.set(analysis.tailSlots.subarray(
        removedSlots,
        removedSlots + tailSlots.length,
    ));
    return { ...analysis, slotCounts, tailSlots };
}

function sealData(data: Readonly<CycleNavigatorData>): CycleNavigatorData {
    const oldSealedCycle = data.cycleActivity.sealedCycle;
    const cycleActivity = sealCycleActivity(
        data.cycleActivity,
        data.confirmedCycle,
        data.observedCycleCount,
    );
    if (cycleActivity.sealedCycle <= oldSealedCycle) {
        return data;
    }
    const topDown = data.topDown === null
        ? null
        : sealTopDown(
            data.topDown,
            oldSealedCycle,
            cycleActivity.sealedCycle,
            data.observedCycleCount,
            cycleActivity.binCycleCount,
        );
    return { ...data, cycleActivity, topDown };
}

/**
 * 最初のsampleを三回まで走査し、以降の増分更新に必要な構造と集計dataを固定する。
 * stage構造の解釈はDetectorへ閉じ、ここではその観測値だけを分類する。
 */
export async function buildCycleNavigatorData(
    trace: ParsedTrace,
    options: Readonly<CycleNavigatorBuildOptions> = {},
): Promise<CycleNavigatorData | null> {
    const traceCycleCount = Math.max(1, Math.ceil(trace.lastCycle));
    const observedCycleCount = traceCycleCount + 1;
    let lastID = trace.lastID;
    let confirmedCycle = 0;
    const yieldInterval = Math.max(1, options.yieldInterval ?? DEFAULT_YIELD_INTERVAL);
    const detector = new StageStructureDetector();
    const cycleActivity = createCycleActivity(
        observedCycleCount,
        options.binCycleCount ?? TRACE_NAVIGATOR_BIN_CYCLE_COUNT,
    );
    let workSinceYield = 0;

    // 一回目: stage構造候補と、構造非依存のFetch／Commitを同時に観測する。
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
            detector.observe(op);
            observeLifecycle(op, cycleActivity);
            if (!op.eof) {
                confirmedCycle = op.fetchedCycle;
            }
        }
        if (++workSinceYield >= yieldInterval) {
            await yieldToBrowser();
            workSinceYield = 0;
        }
    }
    if (options.isCanceled?.()) {
        return null;
    }

    // 二回目: Detector自身が複合frontierと観測幅を検証する。
    const measurement = detector.finish();
    workSinceYield = 0;
    if (measurement !== null) {
        for (let id = 0; id <= lastID; id++) {
            if (options.isCanceled?.()) {
                return null;
            }
            const op = trace.getOpForScan(id);
            if (op !== undefined) {
                measurement.observe(op);
            }
            if (++workSinceYield >= yieldInterval) {
                await yieldToBrowser();
                workSinceYield = 0;
            }
        }
    }

    const structure = measurement?.finish() ?? null;
    const topDown = structure === null
        ? null
        : await buildTopDown(
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
    return sealData({
        cycleCount: Math.max(1, Math.ceil(finalCycle)),
        confirmedCycle: finalCycle,
        observedCycleCount,
        sourceLastID: lastID,
        cycleActivity,
        topDown,
    });
}

/** 初期sample以後に公開されたOpだけを反映し、完成したprefixをbinへ移す。 */
export function updateCycleNavigatorData(
    data: Readonly<CycleNavigatorData>,
    trace: ParsedTrace,
    finished = false,
): CycleNavigatorData {
    const observedCycleCount = Math.max(
        data.observedCycleCount,
        Math.ceil(trace.lastCycle) + 1,
        1,
    );
    const cycleActivity = growCycleActivity(data.cycleActivity, observedCycleCount);
    const topDown = data.topDown === null
        ? null
        : growTopDown(
            data.topDown,
            data.cycleActivity.sealedCycle,
            observedCycleCount,
        );
    if (data.topDown !== null && topDown === null) {
        return data;
    }
    const topDownBytes = topDown === null
        ? 0
        : topDown.slotCounts.byteLength + topDown.tailSlots.byteLength;
    if (topDownBytes + getCycleActivityByteLength(cycleActivity) > MAX_WORKING_BYTES) {
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
        observeLifecycle(op, cycleActivity);
        confirmedCycle = op.fetchedCycle;
        if (topDown !== null) {
            observeDetectedActivity(
                op,
                observeTopDown(topDown, op, cycleActivity.sealedCycle),
                cycleActivity,
            );
        }
    }
    const confirmedEnd = finished
        ? Math.max(1, Math.ceil(trace.lastCycle))
        : confirmedCycle;
    if (sourceLastID === data.sourceLastID &&
        observedCycleCount === data.observedCycleCount &&
        confirmedEnd === data.confirmedCycle) {
        return data;
    }
    return sealData({
        cycleCount: Math.max(1, Math.ceil(confirmedEnd)),
        confirmedCycle: confirmedEnd,
        observedCycleCount,
        sourceLastID,
        cycleActivity,
        topDown,
    });
}

/** stage依存modeを使えない入力だけCommitへ退避する。 */
export function resolveCycleNavigatorMode(
    mode: CycleNavigatorMode,
    ...sources: Array<Readonly<CycleNavigatorData> | null>
): CycleNavigatorMode {
    const stageIndependent = mode === "fetch" || mode === "commit";
    return !stageIndependent && sources.some((source) => source?.topDown === null)
        ? "commit"
        : mode;
}

export function getCycleNavigatorTopDown(
    data: Readonly<CycleNavigatorData>,
    startCycle: number,
    endCycle: number,
): CycleNavigatorTopDownSample | null {
    const analysis = data.topDown;
    if (analysis === null || endCycle <= startCycle) {
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
            const overlap = Math.max(0, Math.min(binnedEnd, binStart + binCycleCount) -
                Math.max(firstCycle, binStart));
            const firstCount = bin * SLOT_CLASS_COUNT;
            for (let slotClass = 0; slotClass < SLOT_CLASS_COUNT; slotClass++) {
                counts[slotClass] += analysis.slotCounts[firstCount + slotClass] *
                    overlap / binCycleCount;
            }
        }
    }
    for (let cycle = Math.max(firstCycle, sealedCycle); cycle < lastCycle; cycle++) {
        const firstSlot = (cycle - sealedCycle) * analysis.allocationWidth;
        for (let slot = firstSlot; slot < firstSlot + analysis.allocationWidth; slot++) {
            counts[analysis.tailSlots[slot]]++;
        }
    }
    const sampledCycleCount = lastCycle - firstCycle;
    return {
        startCycle: firstCycle,
        endCycle: lastCycle,
        totalSlots: sampledCycleCount * analysis.allocationWidth,
        retiringSlots: counts[SlotClass.RETIRING],
        squashedSlots: counts[SlotClass.SQUASHED],
        recoveryBubbleSlots: counts[SlotClass.RECOVERY_BUBBLE],
        unresolvedSlots: counts[SlotClass.UNRESOLVED],
        frontendBound: counts[SlotClass.FRONTEND_BOUND],
        backendBound: counts[SlotClass.BACKEND_BOUND],
        sampledCycleCount,
        samplingStride: firstCycle < sealedCycle ? binCycleCount : 1,
    };
}

export function getCycleNavigatorActivity(
    data: Readonly<CycleNavigatorData>,
    mode: CycleActivityMode,
    startCycle: number,
    endCycle: number,
): CycleActivitySample | null {
    return getCycleActivity(
        data.cycleActivity,
        data.cycleCount,
        mode,
        startCycle,
        endCycle,
    );
}

export function getCycleNavigatorActivityMaximum(
    data: Readonly<CycleNavigatorData>,
    mode: CycleActivityMode,
): number {
    return data.cycleActivity[mode].maximum;
}
