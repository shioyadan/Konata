import type { Op } from "./model";

export interface DetectedStage {
    readonly laneID: number;
    readonly stageName: string;
}

export interface DetectedAllocationStage extends DetectedStage {
    readonly width: number;
}

export interface DetectedAdmissionStage extends DetectedStage {
    readonly typicalLatency: number;
}

export interface DetectedStageStructure {
    readonly allocationStage: Readonly<DetectedAllocationStage>;
    readonly executionStage: Readonly<DetectedStage>;
    readonly completionStages: readonly Readonly<DetectedStage>[];
    readonly transitionCoverage: number;
    readonly admissionStages: readonly Readonly<DetectedAdmissionStage>[];
}

interface StageState extends DetectedStage {
    readonly key: string;
    // 同じ整数cycleに開始した命令数の観測最大値を、stageの投入幅とする。
    width: number;
    startCount: number;
    lastOp: number;
    lastWidthCycle: number;
    startsInCycle: number;
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

/**
 * Traceのstage名を仮定せず、allocation周辺のstage構造を推定する。
 *
 * Opをfile-local ID順に入力すると、各stageについて次のqueueらしい性質を調べる。
 *
 * - 命令がID順にstageへ入る（startCycleが逆転しない）
 * - 後の命令が先にstageを出ることがある（endCycleが一度でも逆転する）
 *
 * このstageが一つだけならallocation proxyとし、観測最大幅、主要な直後段、
 * 全直接前段と通常latency、主要後段の全直後段を返す。命令列やcycle列は保持せず、
 * stageと遷移ごとの逐次状態だけを持つ。
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
            const lane = op.lanes[laneID];
            if (lane === null || lane === undefined) {
                continue;
            }
            let name = "";
            let startCycle = 0;
            let endCycle = 0;
            for (const stage of lane.stages) {
                const stageEnd = stage.endCycle === 0 ? op.retiredCycle : stage.endCycle;
                // 連続する同名stageは一回の滞留へまとめる。離れた再登場は候補から除く。
                if (stage.name === name) {
                    startCycle = Math.min(startCycle, stage.startCycle);
                    endCycle = Math.max(endCycle, stageEnd);
                    continue;
                }
                if (name !== "") {
                    const previous = this.observeStage_(
                        op, observedOp, laneID, name, startCycle, endCycle,
                    );
                    this.observeTransition_(
                        previous,
                        this.getState_(laneID, stage.name),
                        startCycle,
                        endCycle,
                        stage.startCycle,
                    );
                }
                name = stage.name;
                startCycle = stage.startCycle;
                endCycle = stageEnd;
            }
            if (name !== "") {
                this.observeStage_(op, observedOp, laneID, name, startCycle, endCycle);
            }
        }
    }

    finish(): DetectedStageStructure | null {
        let allocation: StageState | null = null;
        for (const state of this.states_.values()) {
            // in-order投入を維持し、終了順だけが逆転したstageをqueue候補にする。
            if (state.invalid || !state.hasRetiredSample || !state.exitInverted || state.width <= 0) {
                continue;
            }
            if (allocation !== null) {
                // 曖昧なtraceではstage名などによる恣意的な選択をしない。
                return null;
            }
            allocation = state;
        }
        if (allocation === null) {
            return null;
        }

        let execution: StageTransition | null = null;
        const admissions: StageTransition[] = [];
        for (const transition of this.transitions_.values()) {
            if (transition.from === allocation &&
                (execution === null || transition.count > execution.count)) {
                execution = transition;
            }
            if (transition.to === allocation && transition.latencies.size > 0) {
                admissions.push(transition);
            }
        }
        if (execution === null) {
            return null;
        }

        const executionStage = execution.to;
        const completionTransitions = [...this.transitions_.values()]
            .filter((transition) => transition.from === executionStage)
            .sort((left, right) => right.count - left.count);
        admissions.sort((left, right) => right.count - left.count);
        return {
            allocationStage: {
                laneID: allocation.laneID,
                stageName: allocation.stageName,
                width: allocation.width,
            },
            executionStage: {
                laneID: executionStage.laneID,
                stageName: executionStage.stageName,
            },
            completionStages: completionTransitions.map((transition) => ({
                laneID: transition.to.laneID,
                stageName: transition.to.stageName,
            })),
            transitionCoverage: Math.min(1, execution.count / allocation.startCount),
            admissionStages: admissions.map((transition) => ({
                laneID: transition.from.laneID,
                stageName: transition.from.stageName,
                typicalLatency: getTypicalLatency(transition.latencies),
            })),
        };
    }

    private getState_(laneID: number, stageName: string): StageState {
        const key = `${laneID}\u0000${stageName}`;
        let state = this.states_.get(key);
        if (state === undefined) {
            state = {
                key,
                laneID,
                stageName,
                width: 0,
                startCount: 0,
                lastOp: -1,
                lastWidthCycle: Number.NEGATIVE_INFINITY,
                startsInCycle: 0,
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

        // flushされた命令も実際に入口を使うため、幅だけは全命令から数える。
        const widthCycle = Math.floor(startCycle);
        if (!Number.isFinite(widthCycle) || widthCycle < state.lastWidthCycle) {
            state.invalid = true;
        } else if (widthCycle === state.lastWidthCycle) {
            state.width = Math.max(state.width, ++state.startsInCycle);
        } else {
            state.lastWidthCycle = widthCycle;
            state.startsInCycle = 1;
            state.width = Math.max(state.width, 1);
        }

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
