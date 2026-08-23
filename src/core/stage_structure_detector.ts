import type { Op } from "./model";

/** 現在推定できるallocation境界と、trace上で観測した最大投入幅。 */
export interface DetectedAllocationStage {
    readonly laneID: number;
    readonly stageName: string;
    readonly width: number;
}

/**
 * Traceから推定したpipeline stage構造。
 * 推定不能または複数候補の要素はnullとし、stage名による恣意的な補完は行わない。
 */
export interface DetectedStageStructure {
    readonly allocation: Readonly<DetectedAllocationStage> | null;
}

// 各threadでstageへの投入順と退出順を逐次比較するための最小状態。
interface ThreadOrderState {
    lastOrder: number;
    maximumStartCycle: number;
    maximumEndCycle: number;
    sampleCount: number;
    invalid: boolean;
    exitInverted: boolean;
}

// lane内の同名stageをまとめた状態。命令列やcycle列は保持しない。
interface StageOrderState {
    readonly laneID: number;
    readonly stageName: string;
    readonly threads: Map<number, ThreadOrderState>;
    repeatedInRetiredOp: boolean;
    lastWidthCycle: number;
    sameCycleStarts: number;
    width: number;
    widthCycleInverted: boolean;
    lastObservedOp: number;
}

/**
 * stage名を仮定せず、Traceからpipeline stageの構造を逐次推定する。
 *
 * 現在は「in-orderに入りout-of-orderに出る唯一のstage」をallocation境界として返す。
 * 将来ほかの構造を推定する場合も、Trace全長に比例する状態を持たず、この走査へ集約する。
 */
export class StageStructureDetector {
    private readonly states_ = new Map<number, Map<string, StageOrderState>>();
    private observedOps_ = 0;

    /** file-local ID順に命令を一度だけ入力する。EOF markerは構造推定へ含めない。 */
    observe(op: Readonly<Op>): void {
        if (op.eof) {
            return;
        }
        const observedOp = this.observedOps_++;
        for (let laneID = 0; laneID < op.lanes.length; laneID++) {
            const lane = op.lanes[laneID];
            if (lane === null || lane === undefined) {
                continue;
            }
            let groupName: string | null = null;
            let groupStartCycle = 0;
            let groupEndCycle = 0;
            for (const stage of lane.stages) {
                const endCycle = stage.endCycle === 0 ? op.retiredCycle : stage.endCycle;
                // 連続する同名stageは一回の滞留として扱う。離れて再登場する場合は
                // 単純なqueue境界ではないためobserveGroup()側で候補から除外する。
                if (stage.name === groupName) {
                    groupStartCycle = Math.min(groupStartCycle, stage.startCycle);
                    groupEndCycle = Math.max(groupEndCycle, endCycle);
                    continue;
                }
                if (groupName !== null) {
                    this.observeGroup(
                        op, laneID, groupName, groupStartCycle, groupEndCycle, observedOp,
                    );
                }
                groupName = stage.name;
                groupStartCycle = stage.startCycle;
                groupEndCycle = endCycle;
            }
            if (groupName !== null) {
                this.observeGroup(
                    op, laneID, groupName, groupStartCycle, groupEndCycle, observedOp,
                );
            }
        }
    }

    /** 観測を確定し、現時点で推定できたstage構造を返す。 */
    finish(): DetectedStageStructure {
        let allocation: DetectedAllocationStage | null = null;
        for (const laneStates of this.states_.values()) {
            for (const state of laneStates.values()) {
                let validOrder = state.threads.size > 0;
                let exitInverted = false;
                for (const thread of state.threads.values()) {
                    validOrder &&= !thread.invalid;
                    exitInverted ||= thread.exitInverted;
                }
                const candidate = !state.repeatedInRetiredOp &&
                    !state.widthCycleInverted && state.width > 0 &&
                    validOrder && exitInverted;
                if (!candidate) {
                    continue;
                }
                // 複数候補をstage名などで恣意的に選ばず、曖昧なtraceでは解析を止める。
                if (allocation !== null) {
                    return { allocation: null };
                }
                allocation = {
                    laneID: state.laneID,
                    stageName: state.stageName,
                    width: state.width,
                };
            }
        }
        return { allocation };
    }

    private getState(laneID: number, stageName: string): StageOrderState {
        let laneStates = this.states_.get(laneID);
        if (laneStates === undefined) {
            laneStates = new Map<string, StageOrderState>();
            this.states_.set(laneID, laneStates);
        }
        let state = laneStates.get(stageName);
        if (state === undefined) {
            state = {
                laneID,
                stageName,
                threads: new Map<number, ThreadOrderState>(),
                repeatedInRetiredOp: false,
                lastWidthCycle: Number.NEGATIVE_INFINITY,
                sameCycleStarts: 0,
                width: 0,
                widthCycleInverted: false,
                lastObservedOp: -1,
            };
            laneStates.set(stageName, state);
        }
        return state;
    }

    private observeGroup(
        op: Readonly<Op>,
        laneID: number,
        stageName: string,
        startCycle: number,
        endCycle: number,
        observedOp: number,
    ): void {
        const state = this.getState(laneID, stageName);
        if (state.lastObservedOp === observedOp) {
            if (op.retired && !op.flush) {
                state.repeatedInRetiredOp = true;
            }
            return;
        }
        state.lastObservedOp = observedOp;
        // 幅はflush命令も実際に消費した観測値なので全命令から数える。一方、投入／退出順は
        // 正常経路だけで検証し、squash時刻が不明なtraceに結果を左右させない。
        const widthCycle = Math.floor(startCycle);
        if (!Number.isFinite(widthCycle)) {
            state.widthCycleInverted = true;
        }
        else if (widthCycle < state.lastWidthCycle) {
            state.widthCycleInverted = true;
        }
        else if (widthCycle === state.lastWidthCycle) {
            state.sameCycleStarts++;
            state.width = Math.max(state.width, state.sameCycleStarts);
        }
        else {
            state.lastWidthCycle = widthCycle;
            state.sameCycleStarts = 1;
            state.width = Math.max(state.width, 1);
        }

        if (!op.retired || op.flush) {
            return;
        }
        let thread = state.threads.get(op.tid);
        if (thread === undefined) {
            thread = {
                lastOrder: Number.NEGATIVE_INFINITY,
                maximumStartCycle: Number.NEGATIVE_INFINITY,
                maximumEndCycle: Number.NEGATIVE_INFINITY,
                sampleCount: 0,
                invalid: false,
                exitInverted: false,
            };
            state.threads.set(op.tid, thread);
        }
        // SMTではthread間のgidや進行cycleが交差するため、順序性はtidごとに判定する。
        const order = op.gid >= 0 ? op.gid : op.id;
        if (!Number.isFinite(startCycle) || !Number.isFinite(endCycle) ||
            endCycle < startCycle || (thread.sampleCount > 0 &&
                (order <= thread.lastOrder || startCycle < thread.maximumStartCycle))) {
            thread.invalid = true;
        }
        if (thread.sampleCount > 0 && endCycle < thread.maximumEndCycle) {
            thread.exitInverted = true;
        }
        thread.lastOrder = order;
        thread.maximumStartCycle = Math.max(thread.maximumStartCycle, startCycle);
        thread.maximumEndCycle = Math.max(thread.maximumEndCycle, endCycle);
        thread.sampleCount++;
    }
}
