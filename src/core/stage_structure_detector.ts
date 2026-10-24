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
    // allocationは一度だけ、発行activityは投機的な試行とreplayもそれぞれ数える。
    readonly executionAttempts: readonly { readonly issueCycle: number; readonly latency: number }[];
    // 後で上流へ戻った試行の完了は、recoveryの起点に使わない。
    readonly completionCycle: number | null;
    readonly admissionStallStartCycle: number | null;
    readonly admissionStallEndCycle: number | null;
    // 発行基準では、bufferの占有区間と最短通過時間を別に扱う。
    readonly issueBufferRanges?: readonly { readonly startCycle: number; readonly endCycle: number }[];
}

export class DetectedStageStructure {
    constructor(
        readonly allocationStage: Readonly<DetectedAllocationStage>,
        readonly executionStage: Readonly<DetectedStageGroup>,
        readonly transitionCoverage: number,
        readonly admissionStages: readonly Readonly<DetectedAdmissionStage>[],
        // 命令ごとの観測方法を非公開にし、Top-down分類へstage構造を漏らさない。
        private readonly executionPaths_: readonly Readonly<DetectedExecutionPath>[],
        readonly basis: "allocation-slots" | "issue-cycles" = "allocation-slots",
        readonly minimumBufferLatency: number = 0,
    ) {}

    observe(op: Readonly<Op>): DetectedStageObservation {
        if (this.basis === "issue-cycles") {
            return observeIssueBuffer(op, this.allocationStage, this.executionStage);
        }
        const allocationNames = this.allocationStage.stageNames;
        let allocationCycle: number | null = null;
        const executionAttempts: { issueCycle: number; latency: number }[] = [];
        const prefixNames = new Set<string>();
        let completionCycle: number | null = null;
        let admissionStallStartCycle: number | null = null;
        let admissionStallEndCycle: number | null = null;
        let selectedPath: Readonly<DetectedExecutionPath> | null = null;
        let awaitingCompletion = false;
        let previousRange: Readonly<StageRange> | null = null;

        visitStageRanges(op, this.allocationStage.laneID, (range) => {
            // 初回発行より前のstageへ戻ったら、以前の完了は取り消す。
            // Schへの再選択だけでなく、より上流へのmemory-order replayも含む。
            if (prefixNames.has(range.name)) {
                completionCycle = null;
                awaitingCompletion = false;
            }
            if (awaitingCompletion) {
                if (selectedPath?.completionStageNames.includes(range.name)) {
                    completionCycle = range.startCycle;
                }
                awaitingCompletion = false;
            }
            if (allocationNames.includes(range.name)) {
                selectedPath = this.executionPaths_.find(
                    (path) => path.allocationStageName === range.name,
                ) ?? null;
                if (allocationCycle === null && previousRange !== null) {
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
                allocationCycle ??= range.startCycle;
                completionCycle = null;
                awaitingCompletion = false;
            } else if (selectedPath !== null &&
                range.name === selectedPath.executionStageName) {
                executionAttempts.push({
                    issueCycle: range.startCycle,
                    latency: Math.max(0, range.endCycle - range.startCycle),
                });
                completionCycle = null;
                awaitingCompletion = true;
            }
            if (executionAttempts.length === 0) {
                prefixNames.add(range.name);
            }
            previousRange = range;
        });
        return {
            allocationCycle,
            executionAttempts,
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
    minimumLatency: number;
    maximumLatency: number;
}

interface StageTransition {
    readonly from: StageState;
    readonly to: StageState;
    count: number;
    hasRetiredSample: boolean;
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

// 検証中の候補と確定済み構造で同じ観測を使い、検証用の仮構造は作らない。
function observeIssueBuffer(
    op: Readonly<Op>,
    bufferStage: Readonly<DetectedStageGroup>,
    executionStage: Readonly<DetectedStageGroup>,
): DetectedStageObservation {
    let allocationCycle: number | null = null;
    const issueBufferRanges: { startCycle: number; endCycle: number }[] = [];
    const executionAttempts: { issueCycle: number; latency: number }[] = [];
    let buffer: { startCycle: number; endCycle: number } | null = null;
    visitStageRanges(op, bufferStage.laneID, (range) => {
        if (bufferStage.stageNames.includes(range.name)) {
            allocationCycle ??= range.startCycle;
            if (buffer !== null && buffer.endCycle === range.startCycle) {
                buffer.endCycle = range.endCycle;
            } else {
                buffer = { startCycle: range.startCycle, endCycle: range.endCycle };
                issueBufferRanges.push(buffer);
            }
        } else {
            if (buffer !== null && buffer.endCycle === range.startCycle &&
                executionStage.stageNames.includes(range.name)) {
                executionAttempts.push({ issueCycle: range.startCycle,
                    latency: Math.max(0, range.endCycle - range.startCycle) });
            }
            buffer = null;
        }
    });
    return { allocationCycle, executionAttempts, completionCycle: null,
        admissionStallStartCycle: null, admissionStallEndCycle: null, issueBufferRanges };
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

// 再帰や全stage対の到達表を使わず、戻り合う状態を線形memoryでまとめる。
function getStageComponents(states: readonly StageState[], edges: readonly StageTransition[]): StageState[][] {
    const forward = new Map(states.map((state) => [state, [] as StageState[]]));
    const backward = new Map(states.map((state) => [state, [] as StageState[]]));
    for (const edge of edges) {
        forward.get(edge.from)!.push(edge.to);
        backward.get(edge.to)!.push(edge.from);
    }
    const visited = new Set<StageState>();
    const order: StageState[] = [];
    for (const state of states) {
        const pending: [StageState, boolean][] = [[state, false]];
        while (pending.length > 0) {
            const [current, expanded] = pending.pop()!;
            if (expanded) { order.push(current); continue; }
            if (visited.has(current)) continue;
            visited.add(current);
            pending.push([current, true]);
            for (const next of forward.get(current)!) pending.push([next, false]);
        }
    }
    const components: StageState[][] = [];
    visited.clear();
    const positions = new Map(states.map((state, index) => [state, index]));
    for (const state of order.reverse()) {
        if (visited.has(state)) continue;
        const group: StageState[] = [];
        const pending = [state];
        while (pending.length > 0) {
            const current = pending.pop()!;
            if (visited.has(current)) continue;
            visited.add(current);
            group.push(current);
            pending.push(...backward.get(current)!);
        }
        components.push(group.sort((a, b) => positions.get(a)! - positions.get(b)!));
    }
    return components;
}

/**
 * 候補stage集合が一つのallocation frontierになるかを再走査で検証する。
 * 候補ごとの最大幅を足さず、集合への実際の新規投入数から幅を求める。
 */
export class StageStructureMeasurement {
    private readonly allocationNames_: ReadonlySet<string>;
    private readonly replayGroups_ = new Map<string, string>();
    private readonly serialPairs_ = new Map<string, Set<string>>();
    private lastWidthCycle_ = Number.NEGATIVE_INFINITY;
    private startsInCycle_ = 0;
    private width_ = 0;
    private invalid_ = false;

    constructor(private readonly draft_: Readonly<StageStructureDraft>) {
        this.allocationNames_ = new Set(draft_.allocationStage.stageNames);
        for (const name of this.allocationNames_) {
            this.replayGroups_.set(name, name);
        }
    }

    observe(op: Readonly<Op>): void {
        if (op.eof) {
            return;
        }
        let firstStartCycle: number | null = null;
        let firstStageName: string | null = null;
        let lastAllocationName: string | null = null;
        // stageを初めて通った時点の直近の候補を覚え、戻り先が同じ下流経路かを調べる。
        // 最初の候補へ一律に結び付けると、上流にある独立した直列queueまで混ざる。
        const visited = new Map<string, string | null>();
        const normal = op.retired && !op.flush;
        visitStageRanges(op, this.draft_.allocationStage.laneID, (range) => {
            if (normal && visited.has(range.name)) {
                const previousAllocation = visited.get(range.name)!;
                if (previousAllocation !== null && lastAllocationName !== null) {
                    this.replayGroups_.set(this.getReplayGroup_(lastAllocationName),
                        this.getReplayGroup_(previousAllocation));
                }
            }
            if (this.allocationNames_.has(range.name)) {
                lastAllocationName = range.name;
                // 後の命令で戻り経路が見つかる場合もあるため、直列関係の判定は
                // sampleを読み終えてから行う。flush／EOFだけを根拠には統合しない。
                if (firstStageName !== null && range.name !== firstStageName && normal) {
                    let pairs = this.serialPairs_.get(firstStageName);
                    if (pairs === undefined) {
                        pairs = new Set<string>();
                        this.serialPairs_.set(firstStageName, pairs);
                    }
                    pairs.add(range.name);
                }
                firstStageName ??= range.name;
                firstStartCycle ??= range.startCycle;
            }
            if (normal && !visited.has(range.name)) {
                visited.set(range.name, lastAllocationName);
            }
        });

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
        for (const [first, following] of this.serialPairs_) {
            if ([...following].some((name) => this.getReplayGroup_(first) !== this.getReplayGroup_(name))) {
                return null;
            }
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

    private getReplayGroup_(name: string): string {
        let group = name;
        while (this.replayGroups_.get(group) !== group) {
            group = this.replayGroups_.get(group)!;
        }
        this.replayGroups_.set(name, group);
        return group;
    }
}

/**
 * Traceのstage名を仮定せず、allocation周辺のstage構造を推定する。
 *
 * Opをfile-local ID順に入力すると、各stageについて次のqueueらしい性質を調べる。
 *
 * - 命令がID順にstageへ初めて入る（startCycleが逆転しない）
 * - 初回の退出について、後の命令が先に出ることがある
 *
 * 同じlaneの複数候補は、二回目の走査で代替状態または同じ下流へのreplayを確認し、
 * 一つのfrontierにまとめる。独立した直列queueは拒否し、初回投入の順序と幅を測る。
 * 前後遷移のない補助laneは候補にせず、命令列やcycle列は保持しない。
 */
export class StageStructureDetector {
    private readonly states_ = new Map<string, StageState>();
    private readonly transitions_ = new Map<string, StageTransition>();
    private observedOps_ = 0;
    private readonly normalThreads_ = new Set<number>();

    observe(op: Readonly<Op>): void {
        if (op.eof) {
            return;
        }
        const observedOp = this.observedOps_++;
        if (op.retired && !op.flush) {
            this.normalThreads_.add(op.tid);
        }
        // 初回訪問だけでqueueの順序性を調べ、再投入を新規命令と混同しない。
        for (let laneID = 0; laneID < op.lanes.length; laneID++) {
            let previousState: StageState | null = null;
            let previousRange: StageRange | null = null;
            visitStageRanges(op, laneID, (range) => {
                const state = this.getState_(laneID, range.name);
                const firstVisit = state.lastOp !== observedOp;
                this.observeStage_(
                    op,
                    observedOp,
                    state,
                    range.startCycle,
                    range.endCycle,
                );
                // 戻り先への遷移を学習すると、queueや前段を実行／完了と誤認する。
                // 各stageの初回入口への直接遷移だけを、各命令で一度ずつ学習する。
                if (firstVisit && previousState !== null && previousRange !== null) {
                    this.observeTransition_(
                        previousState,
                        state,
                        previousRange.startCycle,
                        previousRange.endCycle,
                        range.startCycle,
                        op.retired && !op.flush,
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

    /**
     * OoO frontierが確定しないときの候補。名前ではなく、可変滞留bufferと
     * その直後のID順実行入口を探す。複数候補／複数threadを任意には選ばない。
     */
    finishIssue(): IssueCycleMeasurement | null {
        if (this.normalThreads_.size !== 1) {
            return null;
        }
        const states = [...this.states_.values()].filter((state) => state.hasRetiredSample);
        const edges = [...this.transitions_.values()].filter((edge) => edge.hasRetiredSample);
        const candidates: IssueCandidate[] = [];
        for (const group of getStageComponents(states, edges)) {
            // 待機／ready状態が入れ替わるbufferも一つの連結成分として扱う。
            if (!group.some((member) => member.maximumLatency > member.minimumLatency) ||
                !edges.some((edge) => group.includes(edge.to) && !group.includes(edge.from))) continue;
            const successors = [...new Set(edges.filter((edge) => group.includes(edge.from) &&
                !group.includes(edge.to)).map((edge) => edge.to))];
            if (successors.length === 0 || successors.some((next) => next.invalid)) continue;
            candidates.push({ buffer: { laneID: group[0].laneID,
                stageNames: group.map((member) => member.stageName) },
                execution: { laneID: group[0].laneID,
                    stageNames: successors.map((member) => member.stageName) } });
        }
        return candidates.length === 0 ? null : new IssueCycleMeasurement(candidates);
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
                minimumLatency: Number.POSITIVE_INFINITY,
                maximumLatency: 0,
            };
            this.states_.set(key, state);
        }
        return state;
    }

    private observeStage_(
        op: Readonly<Op>,
        observedOp: number,
        state: StageState,
        startCycle: number,
        endCycle: number,
    ): void {
        if (state.lastOp === observedOp) {
            return;
        }
        state.lastOp = observedOp;
        state.startCount++;

        if (!op.retired || op.flush) {
            return;
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
        state.minimumLatency = Math.min(state.minimumLatency, endCycle - startCycle);
        state.maximumLatency = Math.max(state.maximumLatency, endCycle - startCycle);
        state.hasRetiredSample = true;
    }

    private observeTransition_(
        from: StageState,
        to: StageState,
        fromStartCycle: number,
        fromEndCycle: number,
        toStartCycle: number,
        normal: boolean,
    ): void {
        const key = `${from.key}\u0001${to.key}`;
        let transition = this.transitions_.get(key);
        if (transition === undefined) {
            transition = { from, to, count: 0, hasRetiredSample: false, latencies: new Map<number, number>() };
            this.transitions_.set(key, transition);
        }
        transition.count++;
        transition.hasRetiredSample ||= normal;
        const latency = Math.min(fromEndCycle, toStartCycle) - fromStartCycle;
        if (Number.isFinite(latency) && latency >= 0) {
            transition.latencies.set(
                latency,
                (transition.latencies.get(latency) ?? 0) + 1,
            );
        }
    }
}

interface IssueCandidate {
    readonly buffer: DetectedStageGroup;
    readonly execution: DetectedStageGroup;
}

/** 二回目の走査で実行入口全体の順序、coverage、最短buffer通過時間を検証する。 */
class IssueCycleMeasurement {
    private normalCount_ = 0;
    private readonly candidates_;

    constructor(candidates: readonly IssueCandidate[]) {
        this.candidates_ = candidates.map((candidate) => ({
            ...candidate,
            count: 0, invalid: false, lastIssue: Number.NEGATIVE_INFINITY, minimumLatency: Number.POSITIVE_INFINITY,
            maximumLatency: 0,
        }));
    }

    observe(op: Readonly<Op>): void {
        if (op.eof || !op.retired || op.flush) return;
        this.normalCount_++;
        for (const candidate of this.candidates_) {
            if (candidate.invalid) continue;
            const observed = observeIssueBuffer(op, candidate.buffer, candidate.execution);
            if (observed.executionAttempts.length === 0) continue;
            const issue = observed.executionAttempts[0].issueCycle;
            const entry = observed.allocationCycle!;
            const buffers = observed.issueBufferRanges!;
            if (observed.executionAttempts.length !== 1 || buffers.length !== 1 ||
                !Number.isFinite(entry) || !Number.isFinite(issue) || issue < entry ||
                buffers[0].endCycle !== issue || issue < candidate.lastIssue) {
                candidate.invalid = true;
                continue;
            }
            candidate.count++;
            candidate.lastIssue = issue;
            candidate.minimumLatency = Math.min(candidate.minimumLatency, issue - entry);
            candidate.maximumLatency = Math.max(candidate.maximumLatency, issue - entry);
        }
    }

    finish(): DetectedStageStructure | null {
        const candidates = this.candidates_.filter((candidate) => !candidate.invalid &&
            candidate.count >= 3 && candidate.count / this.normalCount_ >= 0.95 &&
            candidate.maximumLatency > candidate.minimumLatency);
        if (candidates.length !== 1) return null;
        const candidate = candidates[0];
        return new DetectedStageStructure({ ...candidate.buffer, width: 1 },
            candidate.execution, candidate.count / this.normalCount_, [], [],
            "issue-cycles", candidate.minimumLatency);
    }
}
