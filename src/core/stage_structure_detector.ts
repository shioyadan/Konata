import type { Op } from "./model";

export interface DetectedStage {
    readonly laneID: number;
    readonly stageName: string;
}

export interface DetectedStageGroup {
    readonly laneID: number;
    readonly stageNames: readonly string[];
}

export interface DetectedAllocationStage extends DetectedStageGroup {
    readonly width: number;
}

export interface DetectedAdmissionStage extends DetectedStage {
    readonly typicalLatency: number;
}

interface DetectedExecutionPath {
    readonly allocationStageName: string;
    readonly executionStageName: string;
    readonly completionStageNames: readonly string[];
}

export interface DetectedStageObservation {
    readonly allocationCycle: number | null;
    readonly issueCycle: number | null;
    readonly executionLatency: number | null;
    readonly completionCycle: number | null;
    readonly admissionStallStartCycle: number | null;
    readonly admissionStallEndCycle: number | null;
}

export class DetectedStageStructure {
    constructor(
        readonly allocationStage: Readonly<DetectedAllocationStage>,
        readonly executionStage: Readonly<DetectedStageGroup>,
        readonly transitionCoverage: number,
        readonly admissionStages: readonly Readonly<DetectedAdmissionStage>[],
        // 命令ごとの観測方法を非公開にし、Top-down分類へstage構造を漏らさない。
        private readonly executionPaths_: readonly Readonly<DetectedExecutionPath>[],
    ) {}

    observe(op: Readonly<Op>): DetectedStageObservation {
        const allocationNames = this.allocationStage.stageNames;
        let allocationCycle: number | null = null;
        let issueCycle: number | null = null;
        let executionLatency: number | null = null;
        let completionCycle: number | null = null;
        let admissionStallStartCycle: number | null = null;
        let admissionStallEndCycle: number | null = null;
        let selectedPath: Readonly<DetectedExecutionPath> | null = null;
        let awaitingCompletion = false;
        let previousRange: Readonly<StageRange> | null = null;

        visitStageRanges(op, this.allocationStage.laneID, (range) => {
            if (awaitingCompletion) {
                if (selectedPath?.completionStageNames.includes(range.name)) {
                    completionCycle = range.startCycle;
                }
                awaitingCompletion = false;
            }
            if (allocationCycle === null && allocationNames.includes(range.name)) {
                allocationCycle = range.startCycle;
                selectedPath = this.executionPaths_.find(
                    (path) => path.allocationStageName === range.name,
                ) ?? null;
                if (previousRange !== null) {
                    const admission = this.admissionStages.find(
                        (stage) => stage.laneID === this.allocationStage.laneID &&
                            stage.stageName === previousRange?.name,
                    );
                    if (admission !== undefined) {
                        admissionStallStartCycle = previousRange.startCycle +
                            admission.typicalLatency;
                        admissionStallEndCycle = Math.min(
                            previousRange.endCycle,
                            range.startCycle,
                        );
                    }
                }
            } else if (issueCycle === null && selectedPath !== null &&
                range.name === selectedPath.executionStageName) {
                issueCycle = range.startCycle;
                executionLatency = Math.max(0, range.endCycle - range.startCycle);
                awaitingCompletion = true;
            }
            previousRange = range;
        });
        return {
            allocationCycle,
            issueCycle,
            executionLatency,
            completionCycle,
            admissionStallStartCycle,
            admissionStallEndCycle,
        };
    }
}

interface StageState extends DetectedStage {
    readonly key: string;
    startCount: number;
    lastOp: number;
    // 正常リタイア命令について、開始順と終了順を逐次比較するための状態。
    lastStartCycle: number;
    maximumEndCycle: number;
    hasRetiredSample: boolean;
    invalid: boolean;
    exitInverted: boolean;
}

interface StageTransition {
    readonly from: StageState;
    readonly to: StageState;
    count: number;
    readonly latencies: Map<number, number>;
}

interface StageRange {
    readonly name: string;
    readonly startCycle: number;
    readonly endCycle: number;
}

interface StageStructureDraft {
    readonly allocationStage: Omit<DetectedAllocationStage, "width">;
    readonly executionStage: DetectedStageGroup;
    readonly transitionCoverage: number;
    readonly admissionStages: readonly DetectedAdmissionStage[];
    readonly executionPaths: readonly DetectedExecutionPath[];
}

function visitStageRanges(
    op: Readonly<Op>,
    laneID: number,
    visit: (range: Readonly<StageRange>) => void,
): void {
    const lane = op.lanes[laneID];
    if (lane === null || lane === undefined) {
        return;
    }
    let name = "";
    let startCycle = 0;
    let endCycle = 0;
    for (const stage of lane.stages) {
        const stageEnd = stage.endCycle === 0 ? op.retiredCycle : stage.endCycle;
        // 連続する同名stageは一回の滞留として扱う。
        if (stage.name === name) {
            startCycle = Math.min(startCycle, stage.startCycle);
            endCycle = Math.max(endCycle, stageEnd);
            continue;
        }
        if (name !== "") {
            visit({ name, startCycle, endCycle });
        }
        name = stage.name;
        startCycle = stage.startCycle;
        endCycle = stageEnd;
    }
    if (name !== "") {
        visit({ name, startCycle, endCycle });
    }
}

function getTypicalLatency(histogram: ReadonlyMap<number, number>): number {
    let typicalLatency = 0;
    let typicalCount = -1;
    for (const [latency, count] of histogram) {
        if (count > typicalCount || (count === typicalCount && latency < typicalLatency)) {
            typicalLatency = latency;
            typicalCount = count;
        }
    }
    return typicalLatency;
}

function mergeHistogram(target: Map<number, number>, source: ReadonlyMap<number, number>): void {
    for (const [value, count] of source) {
        target.set(value, (target.get(value) ?? 0) + count);
    }
}

/**
 * 候補stage集合が一つのallocation frontierになるかを再走査で検証する。
 * 候補ごとの最大幅を足さず、集合への実際の新規投入数から幅を求める。
 */
export class StageStructureMeasurement {
    private readonly allocationNames_: ReadonlySet<string>;
    private lastWidthCycle_ = Number.NEGATIVE_INFINITY;
    private startsInCycle_ = 0;
    private width_ = 0;
    private invalid_ = false;

    constructor(private readonly draft_: Readonly<StageStructureDraft>) {
        this.allocationNames_ = new Set(draft_.allocationStage.stageNames);
    }

    observe(op: Readonly<Op>): void {
        if (op.eof) {
            return;
        }
        let firstStartCycle: number | null = null;
        let allocationStageCount = 0;
        visitStageRanges(op, this.draft_.allocationStage.laneID, (range) => {
            if (!this.allocationNames_.has(range.name)) {
                return;
            }
            allocationStageCount++;
            firstStartCycle ??= range.startCycle;
        });

        // 正常経路で複数候補を直列に通る場合は、代替状態の集合とはみなさない。
        if (op.retired && !op.flush && allocationStageCount > 1) {
            this.invalid_ = true;
        }
        if (firstStartCycle === null) {
            return;
        }
        const widthCycle = Math.floor(firstStartCycle);
        if (!Number.isFinite(widthCycle) || widthCycle < this.lastWidthCycle_) {
            this.invalid_ = true;
        } else if (widthCycle === this.lastWidthCycle_) {
            this.width_ = Math.max(this.width_, ++this.startsInCycle_);
        } else {
            this.lastWidthCycle_ = widthCycle;
            this.startsInCycle_ = 1;
            this.width_ = Math.max(this.width_, 1);
        }
    }

    finish(): DetectedStageStructure | null {
        if (this.invalid_ || this.width_ <= 0) {
            return null;
        }
        return new DetectedStageStructure(
            {
                ...this.draft_.allocationStage,
                width: this.width_,
            },
            this.draft_.executionStage,
            this.draft_.transitionCoverage,
            this.draft_.admissionStages,
            this.draft_.executionPaths,
        );
    }
}

/**
 * Traceのstage名を仮定せず、allocation周辺のstage構造を推定する。
 *
 * Opをfile-local ID順に入力すると、各stageについて次のqueueらしい性質を調べる。
 *
 * - 命令がID順にstageへ入る（startCycleが逆転しない）
 * - 後の命令が先にstageを出ることがある（endCycleが一度でも逆転する）
 *
 * 同じlaneに複数候補がある場合は、二回目の走査で一命令が候補を一つだけ通ることと
 * 集合全体の投入順を確認し、ready／waitなどの代替状態を一つのfrontierにまとめる。
 * 前後遷移のない補助laneは候補にせず、命令列やcycle列は保持しない。
 */
export class StageStructureDetector {
    private readonly states_ = new Map<string, StageState>();
    private readonly transitions_ = new Map<string, StageTransition>();
    private observedOps_ = 0;

    observe(op: Readonly<Op>): void {
        if (op.eof) {
            return;
        }
        const observedOp = this.observedOps_++;
        // laneごとに、この命令が通過した各stageの滞留区間と直接遷移を観測する。
        for (let laneID = 0; laneID < op.lanes.length; laneID++) {
            let previousState: StageState | null = null;
            let previousRange: StageRange | null = null;
            visitStageRanges(op, laneID, (range) => {
                const state = this.observeStage_(
                    op,
                    observedOp,
                    laneID,
                    range.name,
                    range.startCycle,
                    range.endCycle,
                );
                if (previousState !== null && previousRange !== null) {
                    this.observeTransition_(
                        previousState,
                        state,
                        previousRange.startCycle,
                        previousRange.endCycle,
                        range.startCycle,
                    );
                }
                previousState = state;
                previousRange = range;
            });
        }
    }

    finish(): StageStructureMeasurement | null {
        const incoming = new Set<StageState>();
        const outgoing = new Set<StageState>();
        for (const transition of this.transitions_.values()) {
            outgoing.add(transition.from);
            incoming.add(transition.to);
        }
        const allocations = [...this.states_.values()].filter((state) =>
            !state.invalid && state.hasRetiredSample && state.exitInverted &&
            incoming.has(state) && outgoing.has(state),
        );
        if (allocations.length === 0) {
            return null;
        }
        const laneID = allocations[0].laneID;
        if (allocations.some((state) => state.laneID !== laneID)) {
            // laneをまたぐ候補は補助表示か独立queueかを区別できないため選ばない。
            return null;
        }

        const allocationKeys = new Set(allocations.map((state) => state.key));
        const executionPaths: DetectedExecutionPath[] = [];
        const executionNames: string[] = [];
        let selectedTransitionCount = 0;
        for (const allocation of allocations) {
            let execution: StageTransition | null = null;
            for (const transition of this.transitions_.values()) {
                if (transition.from !== allocation || allocationKeys.has(transition.to.key)) {
                    continue;
                }
                if (execution === null || transition.count > execution.count) {
                    execution = transition;
                }
            }
            if (execution === null) {
                return null;
            }
            selectedTransitionCount += execution.count;
            if (!executionNames.includes(execution.to.stageName)) {
                executionNames.push(execution.to.stageName);
            }
            const completionNames: string[] = [];
            for (const transition of this.transitions_.values()) {
                if (transition.from === execution.to &&
                    !completionNames.includes(transition.to.stageName)) {
                    completionNames.push(transition.to.stageName);
                }
            }
            executionPaths.push({
                allocationStageName: allocation.stageName,
                executionStageName: execution.to.stageName,
                completionStageNames: completionNames,
            });
        }

        // 複合frontierの入口latencyは、同じ前段から各代替状態への観測をまとめる。
        const admissionHistograms = new Map<string, {
            readonly stage: StageState;
            count: number;
            readonly latencies: Map<number, number>;
        }>();
        for (const transition of this.transitions_.values()) {
            if (!allocationKeys.has(transition.to.key) || allocationKeys.has(transition.from.key)) {
                continue;
            }
            let admission = admissionHistograms.get(transition.from.key);
            if (admission === undefined) {
                admission = {
                    stage: transition.from,
                    count: 0,
                    latencies: new Map<number, number>(),
                };
                admissionHistograms.set(transition.from.key, admission);
            }
            admission.count += transition.count;
            mergeHistogram(admission.latencies, transition.latencies);
        }
        const admissionStages = [...admissionHistograms.values()]
            .sort((left, right) => right.count - left.count)
            .map((admission) => ({
                laneID: admission.stage.laneID,
                stageName: admission.stage.stageName,
                typicalLatency: getTypicalLatency(admission.latencies),
            }));
        const startCount = allocations.reduce((sum, state) => sum + state.startCount, 0);
        return new StageStructureMeasurement({
            allocationStage: {
                laneID,
                stageNames: allocations.map((state) => state.stageName),
            },
            executionStage: {
                laneID,
                stageNames: executionNames,
            },
            transitionCoverage: Math.min(1, selectedTransitionCount / startCount),
            admissionStages,
            executionPaths,
        });
    }

    private getState_(laneID: number, stageName: string): StageState {
        const key = `${laneID}\u0000${stageName}`;
        let state = this.states_.get(key);
        if (state === undefined) {
            state = {
                key,
                laneID,
                stageName,
                startCount: 0,
                lastOp: -1,
                lastStartCycle: Number.NEGATIVE_INFINITY,
                maximumEndCycle: Number.NEGATIVE_INFINITY,
                hasRetiredSample: false,
                invalid: false,
                exitInverted: false,
            };
            this.states_.set(key, state);
        }
        return state;
    }

    private observeStage_(
        op: Readonly<Op>,
        observedOp: number,
        laneID: number,
        stageName: string,
        startCycle: number,
        endCycle: number,
    ): StageState {
        const state = this.getState_(laneID, stageName);
        if (state.lastOp === observedOp) {
            // 正常経路で同じstageが離れて再登場する構造は、単純なqueueとはみなさない。
            state.invalid ||= op.retired && !op.flush;
            return state;
        }
        state.lastOp = observedOp;
        state.startCount++;

        if (!op.retired || op.flush) {
            return state;
        }
        // 投入／退出順はsquash時刻に左右されない正常経路だけで判定する。
        if (!Number.isFinite(startCycle) || !Number.isFinite(endCycle) ||
            endCycle < startCycle || startCycle < state.lastStartCycle) {
            state.invalid = true;
        }
        if (state.hasRetiredSample && endCycle < state.maximumEndCycle) {
            // 後から入った命令が、それ以前の命令より先に出たことを示す。
            state.exitInverted = true;
        }
        state.lastStartCycle = Math.max(state.lastStartCycle, startCycle);
        state.maximumEndCycle = Math.max(state.maximumEndCycle, endCycle);
        state.hasRetiredSample = true;
        return state;
    }

    private observeTransition_(
        from: StageState,
        to: StageState,
        fromStartCycle: number,
        fromEndCycle: number,
        toStartCycle: number,
    ): void {
        const key = `${from.key}\u0001${to.key}`;
        let transition = this.transitions_.get(key);
        if (transition === undefined) {
            transition = { from, to, count: 0, latencies: new Map<number, number>() };
            this.transitions_.set(key, transition);
        }
        transition.count++;
        const latency = Math.min(fromEndCycle, toStartCycle) - fromStartCycle;
        if (Number.isFinite(latency) && latency >= 0) {
            transition.latencies.set(
                latency,
                (transition.latencies.get(latency) ?? 0) + 1,
            );
        }
    }
}
