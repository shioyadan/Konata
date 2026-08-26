import type { Op } from "./model";

export interface DetectedAllocationStage {
    readonly laneID: number;
    readonly stageName: string;
    readonly width: number;
}

export interface DetectedStageStructure {
    readonly allocation: Readonly<DetectedAllocationStage> | null;
}

interface StageState {
    readonly laneID: number;
    readonly stageName: string;
    width: number;
    lastOp: number;
    lastWidthCycle: number;
    startsInCycle: number;
    lastStartCycle: number;
    maximumEndCycle: number;
    hasRetiredSample: boolean;
    invalid: boolean;
    exitInverted: boolean;
}

/** ID順に入り、out-of-orderに出る唯一のstageをallocation境界とみなす。 */
export class StageStructureDetector {
    private readonly states_ = new Map<string, StageState>();
    private observedOps_ = 0;

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
                    this.observeStage_(op, observedOp, laneID, name, startCycle, endCycle);
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

    finish(): DetectedStageStructure {
        let allocation: DetectedAllocationStage | null = null;
        for (const state of this.states_.values()) {
            if (state.invalid || !state.hasRetiredSample || !state.exitInverted || state.width <= 0) {
                continue;
            }
            if (allocation !== null) {
                // 曖昧なtraceではstage名などによる恣意的な選択をしない。
                return { allocation: null };
            }
            allocation = {
                laneID: state.laneID,
                stageName: state.stageName,
                width: state.width,
            };
        }
        return { allocation };
    }

    private observeStage_(
        op: Readonly<Op>,
        observedOp: number,
        laneID: number,
        stageName: string,
        startCycle: number,
        endCycle: number,
    ): void {
        const key = `${laneID}\u0000${stageName}`;
        let state = this.states_.get(key);
        if (state === undefined) {
            state = {
                laneID,
                stageName,
                width: 0,
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
        if (state.lastOp === observedOp) {
            state.invalid ||= op.retired && !op.flush;
            return;
        }
        state.lastOp = observedOp;

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
            return;
        }
        // 投入／退出順はsquash時刻に左右されない正常経路だけで判定する。
        if (!Number.isFinite(startCycle) || !Number.isFinite(endCycle) ||
            endCycle < startCycle || startCycle < state.lastStartCycle) {
            state.invalid = true;
        }
        if (state.hasRetiredSample && endCycle < state.maximumEndCycle) {
            state.exitInverted = true;
        }
        state.lastStartCycle = Math.max(state.lastStartCycle, startCycle);
        state.maximumEndCycle = Math.max(state.maximumEndCycle, endCycle);
        state.hasRetiredSample = true;
    }
}
