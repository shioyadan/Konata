/**
 * CLIの不変snapshotをWebの解析modelへ接続し、Top-down-likeの数値結果を返す。
 * 構造検出・slot分類はcoreに任せる。CLIのID／絶対cycleや終了不明値は変更しない。
 * 検索・表示位置・Node入出力は持たず、解析用の一時storeは応答後に解放する。
 */
import { getOrCreateLane, Op, ParsedTrace, Stage, StageLevelMap } from "../core/model";
import { ArrayOpStore } from "../core/op_store";
import { buildCycleNavigatorData, getCycleNavigatorTopDown } from "../core/trace_navigator_analysis";
import type { CliTrace } from "./session";

type CycleRange = { begin: number; end: number };
type Share = { slots: number; percentage: number };
const MAX_TRACE_CYCLES = 4_000_000;

export interface CliTopDownResult {
    kind: "topdown";
    model: "konata-top-down-like-v1";
    available: boolean;
    reason: { code: string; message: string } | null;
    scope: { source: string; requestedRange: CycleRange | null; range: CycleRange | null;
        complete: boolean; instructionCount: number; excludedIncompleteInstructions: number };
    analysis: { allocation: { lane: string; stages: readonly string[] };
        execution: { lane: string; stages: readonly string[] }; allocationWidth: number;
        transitionCoverage: number; binCycles: number; binOrigin: number; interpolated: boolean;
        minimumRecoveryCycles: number | null; minimumRecoverySampleCount: number } | null;
    totals: { cycles: number; totalSlots: number; retiring: Share; frontendBound: Share;
        backendBound: Share; unresolved: Share;
        badSpeculation: Share & { squashedSlots: number; recoveryBubbleSlots: number } } | null;
}

export async function analyzeCliTopDown(trace: CliTrace, complete: boolean,
    requestedRange: CycleRange | null, isCanceled: () => boolean): Promise<CliTopDownResult> {
    // live配列自体は次の通知で書き換わるため、最初のawaitより前に参照を固定する。
    const instructions = [...trace.instructions].sort((a, b) => a.id - b.id);
    const range = { begin: Math.max(trace.range.begin, requestedRange?.begin ?? trace.range.begin),
        end: Math.min(trace.range.end, requestedRange?.end ?? trace.range.end) };
    const result: CliTopDownResult = { kind: "topdown", model: "konata-top-down-like-v1",
        available: false, reason: null,
        scope: { source: trace.source, requestedRange, range: range.end > range.begin ? range : null,
            complete, instructionCount: instructions.length,
            excludedIncompleteInstructions: instructions.filter((op) => op.status === "incomplete").length },
        analysis: null, totals: null };
    const unavailable = (code: string, message: string) => {
        result.reason = { code, message };
        return result;
    };
    if (result.scope.range === null) return unavailable("empty_range", "No observed cycles overlap the requested range.");
    const span = trace.range.end - trace.range.begin;
    // coreは最初にcycle配列を作る。巨大な絶対cycleをそのまま容量にせず、prototypeの
    // 上限を割当て前に検査する（全体の構造を使うので、短いqueryでも解析対象は全体）。
    if (!Number.isSafeInteger(span) || span > MAX_TRACE_CYCLES) {
        return unavailable("analysis_limit", "The available trace span exceeds the initial analysis limit (4000000 cycles).");
    }
    const store = new ArrayOpStore();
    const levels = new StageLevelMap();
    // coreのendCycle=0は未閉鎖のsentinel。32を足し、実際の0長／先頭cycleを
    // sentinelと混同しない。binは入力範囲の先頭を原点とし、その原点も結果へ残す。
    const cycle = (value: number) => value - trace.range.begin + 32;
    let deadline = performance.now() + 8;
    try {
        for (let index = 0; index < instructions.length; index++) {
            if (isCanceled()) return unavailable("canceled", "The trace was replaced during analysis.");
            const source = instructions[index];
            const op = new Op();
            // IDの大小順は保ち、穴だけを詰める。外部のCLI命令IDは書き換えない。
            op.id = index; op.gid = source.gid; op.tid = source.thread ?? -1;
            op.retired = source.status === "retired"; op.flush = source.status === "flushed";
            op.eof = source.status === "incomplete";
            op.fetchedCycle = cycle(source.begin);
            op.retiredCycle = source.end === null ? -1 : cycle(source.end);
            // thread不明の命令同士を同じthreadの因果列とみなさない。回復推定の
            // control-flow gateだけを無効にし、記録されたラベルとslot分類は保つ。
            op.labelName = source.thread === null ? "" : source.label;
            for (const value of source.stages) {
                // 開いた区間のendは補完しない。EOF命令はWebと同様にcoreが除外する。
                if (value.end === null) continue;
                const lane = getOrCreateLane(op, levels.getOrCreateLaneID(value.lane));
                const stage = new Stage();
                stage.name = value.name; stage.startCycle = cycle(value.begin); stage.endCycle = cycle(value.end);
                lane.stages.push(stage);
                levels.update(value.lane, value.name, lane);
            }
            store.setOp(index, op);
            if ((index + 1) % 8192 === 0 || performance.now() >= deadline) {
                await new Promise<void>((resolve) => setTimeout(resolve, 0));
                deadline = performance.now() + 8;
            }
        }
        const parsed = new ParsedTrace(trace.source, store, levels, span + 32);
        const data = await buildCycleNavigatorData(parsed, { isCanceled });
        if (isCanceled()) return unavailable("canceled", "The trace was replaced during analysis.");
        if (data === null || data.topDown === null) {
            return unavailable("unavailable", "No supported stage structure was detected, or the shared analyzer's resource limit was exceeded.");
        }
        const sample = getCycleNavigatorTopDown(data, cycle(range.begin), cycle(range.end));
        if (sample === null) return unavailable("empty_range", "No analyzed cycles overlap the requested range.");
        const { topDown, cycleActivity: { binCycleCount, sealedCycle } } = data;
        const stageGroup = (group: { laneID: number; stageNames: readonly string[] }) => ({
            lane: levels.getLaneName(group.laneID)!, stages: [...group.stageNames],
        });
        const share = (slots: number): Share => ({ slots, percentage: slots / sample.totalSlots * 100 });
        result.available = true;
        result.analysis = {
            allocation: stageGroup(topDown.structure.allocationStage),
            execution: stageGroup(topDown.structure.executionStage),
            allocationWidth: topDown.allocationWidth, transitionCoverage: topDown.transitionCoverage,
            binCycles: binCycleCount, binOrigin: trace.range.begin,
            interpolated: sample.startCycle < sealedCycle &&
                (sample.startCycle % binCycleCount !== 0 || Math.min(sample.endCycle, sealedCycle) % binCycleCount !== 0),
            minimumRecoveryCycles: topDown.minimumRecoveryCycles,
            minimumRecoverySampleCount: topDown.minimumRecoverySampleCount,
        };
        result.totals = { cycles: sample.sampledCycleCount, totalSlots: sample.totalSlots,
            retiring: share(sample.retiringSlots), frontendBound: share(sample.frontendBound),
            backendBound: share(sample.backendBound), unresolved: share(sample.unresolvedSlots),
            badSpeculation: { ...share(sample.squashedSlots + sample.recoveryBubbleSlots),
                squashedSlots: sample.squashedSlots, recoveryBubbleSlots: sample.recoveryBubbleSlots } };
        return result;
    }
    finally { store.close(); }
}
