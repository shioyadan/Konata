/**
 * Nodeのファイル入力と共有Parserを、CLI用の読取り専用データへつなぐ境界。
 * 展開・行読込み・Kanata／gem5解析はcoreを再利用し、CLIの時刻・整数契約を入力側で扱う。
 * 疎なIDを一時storeへ保持し、EOFの表示用終端を除いて未知の終了をnullとして返す。
 * Parserの途中通知から変更済み命令だけを写し、入力が終わる前にも閲覧できるようにする。
 * sessionの表示位置・検索・出力形式は扱わず、現段階では1ログを全量memoryへ読み込む。
 */
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";

import { FileLineReader, type ProgressCallback, type TraceInput } from "../core/file_line_reader";
import { Gem5O3PipeViewParser } from "../core/gem5_o3_pipe_view_parser";
import type { Op, ParsedTrace, Stage } from "../core/model";
import { OnikiriParser } from "../core/onikiri_parser";
import type { MutableOpStore } from "../core/op_store";
import type { CliInstruction, CliLoadOptions, CliTrace } from "./session";

// CLI固有の整数契約と絶対cycleを入力側で処理し、共有Parserの設定分岐を増やさない。
class InspectionLineReader extends FileLineReader {
    constructor(input: TraceInput, private readonly notifyBetweenChunks = false) { super(input); }

    override async readLines(
        onLine: (line: string) => void,
        onProgress?: ProgressCallback,
        signal?: AbortSignal,
    ): Promise<void> {
        let cycle = 0;
        let lineNumber = 0;
        let kanata = false;
        const inspectLine = (line: string) => {
            lineNumber++;
            const integer = (text: string): number => {
                const normalized = text.trim();
                const value = Number(normalized);
                if (!/^[+-]?\d+$/.test(normalized) || !Number.isSafeInteger(value)) {
                    throw new Error(`Unsafe or invalid integer at line ${lineNumber}: ${text}`);
                }
                return value;
            };
            if (lineNumber === 1) kanata = /^Kanata/.test(line);
            // gem5の数値は共有ParserがNumberへ変換する前に検査し、桁落ちを持ち込まない。
            // 形式の受理・stage解釈は共有Parserへ任せ、入力を別形式へ書き換えない。
            if (!kanata) {
                if (line.startsWith("O3PipeView:")) {
                    const fields = line.split(":");
                    const numbers = fields[1] === "fetch" ? [2, 4, 5] : fields[1] === "thread" ? [2, 3] : [2];
                    for (const field of numbers) {
                        if (fields[field] !== undefined && integer(fields[field]) < 0) {
                            throw new Error(`Negative gem5 number at line ${lineNumber}.`);
                        }
                    }
                    if (fields[1] === "retire") {
                        for (let index = 3; index + 1 < fields.length; index += 2) {
                            if (fields[index] === "store") integer(fields[index + 1]);
                        }
                    }
                }
                else {
                    const tick = /^\s*(\d+)\s*:/.exec(line);
                    if (tick !== null) integer(tick[1]);
                    for (const match of line.matchAll(/(?:sn:|\[tid:\s*)(\d+)/g)) integer(match[1]);
                }
                onLine(line);
                return;
            }
            const args = line.split("\t");
            const command = args[0];
            if (command === "C" || command === "C=") {
                if (args[1] === undefined) {
                    onLine("C");
                    return;
                }
                const value = integer(args[1]);
                const next = command === "C=" ? value : cycle + value;
                const delta = next - cycle;
                if (!Number.isSafeInteger(next) || !Number.isSafeInteger(delta) ||
                    (command === "C" && value < 0)) {
                    throw new Error(`Invalid or overflowing cycle increment at line ${lineNumber}.`);
                }
                cycle = next;
                // 行数を保ってCへ変換し、命令のsource lineとParserの警告位置をずらさない。
                onLine(`C\t${delta}`);
                return;
            }
            if (command.length === 1 && "ILSERW".includes(command) && args[1] !== undefined) {
                if (integer(args[1]) < 0) throw new Error(`Negative instruction ID at line ${lineNumber}.`);
                const lastField = "IRW".includes(command) ? 3 : command === "L" ? 2 : 1;
                for (let field = 2; field <= lastField && field < args.length; field++) integer(args[field]);
            }
            onLine(line);
        };
        let active = true;
        let pending = false;
        let updateError: unknown;
        try {
            await super.readLines((line) => {
                inspectLine(line);
                // Readerが次chunkを待つ非同期境界でも通知する。8192行未満の入力で停止しても
                // 既読命令を使えるようにし、行ごとのPromiseやGUI側の変更は増やさない。
                if (this.notifyBetweenChunks && !pending) {
                    pending = true;
                    queueMicrotask(() => {
                        pending = false;
                        if (!active || signal?.aborted) return;
                        try { onProgress?.(this.progress); }
                        catch (error) {
                            updateError = error;
                            void this.cancel().catch(() => undefined);
                        }
                    });
                }
            }, onProgress, signal);
            if (updateError !== undefined) throw updateError;
        }
        finally { active = false; }
    }
}

// 疎なIDを全走査せず、入力に現れた命令だけ保持する小規模調査向けstore。
class InspectionOpStore implements MutableOpStore {
    readonly ops = new Map<number, Op>();
    readonly changed = new Set<number>();
    private readonly retired = new Map<number, number>();
    lastID = -1;
    lastRID = -1;

    get opCount(): number { return this.ops.size; }
    getOp(id: number): Op | undefined { return this.ops.get(id); }
    getOpForScan(id: number): Op | undefined { return this.ops.get(id); }
    getOpFromRID(rid: number): Op | undefined {
        const id = this.retired.get(rid);
        return id === undefined ? undefined : this.ops.get(id);
    }
    setOp(id: number, op: Op): void {
        this.ops.set(id, op);
        this.changed.add(id);
        this.lastID = Math.max(this.lastID, id);
    }
    setRetiredOp(rid: number, op: Op): void {
        this.retired.set(rid, op.id);
        this.lastRID = Math.max(this.lastRID, rid);
    }
    close(): void {
        this.ops.clear();
        this.retired.clear();
        this.changed.clear();
    }
}

// Node 18のReadable.toWebは形式fallbackの途中cancel後にcontrollerを再度閉じる場合がある。
// pull単位でNodeのiteratorを読むことでbackpressureを保ち、cancel後の結果を公開しない。
function fileStream(source: string): ReadableStream<Uint8Array> {
    const stream = createReadStream(source);
    const iterator = stream[Symbol.asyncIterator]();
    let canceled = false;
    return new ReadableStream<Uint8Array>({
        async pull(controller) {
            try {
                const chunk = await iterator.next();
                if (canceled) return;
                if (chunk.done) controller.close();
                else controller.enqueue(chunk.value);
            }
            catch (error) {
                if (!canceled) controller.error(error);
            }
        },
        async cancel() {
            canceled = true;
            stream.destroy();
            await iterator.return?.().catch(() => undefined);
        },
    });
}

export async function loadCliTrace(filePath: string, options: CliLoadOptions = {}): Promise<CliTrace> {
    options.signal?.throwIfAborted();
    const source = path.resolve(filePath);
    const info = await stat(source);
    if (!info.isFile()) {
        throw new Error("The trace path must refer to a regular file.");
    }
    const input: TraceInput = {
        name: path.basename(source),
        size: info.size,
        type: "",
        stream: () => fileStream(source),
    };
    return inspectCliTrace(input, source, options);
}

// ParserはGUIと共有するが、EOFの表示用retiredCycleを記録された終了として公開しない。
// 差分を不変objectへ写し、Parserによる後続更新やcancelで公開済みの詳細を変化させない。
function instruction(op: Op, trace: ParsedTrace, format: "kanata" | "gem5", source: string,
    closed: WeakSet<Stage>): CliInstruction {
    const incomplete = format === "kanata" ? op.eof : !op.retired && !op.flush;
    // gem5は描画用にRt／flushの0長stageを1 cycleへ広げる。CLIは次stageの
    // 始点と記録された終端を使い、滞在時間に描画幅を混ぜない。未完了の末尾はnull。
    const gem5End = op.lanes.flatMap((lane) => lane?.stages ?? []).at(-1)?.startCycle ?? op.fetchedCycle;
    const end = incomplete ? null : format === "gem5" ? gem5End : op.retiredCycle;
    const stages = op.lanes.flatMap((lane, laneID) => lane?.stages.map((stage, index) => ({
        lane: trace.laneNames[laneID], name: stage.name, label: stage.labels, begin: stage.startCycle,
        end: format === "kanata" ? closed.has(stage) ? stage.endCycle : null :
            lane.stages[index + 1]?.startCycle ?? end,
    })) ?? []);
    const numbers = [op.id, op.gid, op.rid, op.tid, op.fetchedCycle,
        ...(end === null ? [] : [end]), ...stages.flatMap((stage) =>
            stage.end === null ? [stage.begin] : [stage.begin, stage.end])];
    if (numbers.some((value) => !Number.isSafeInteger(value))) {
        throw new Error(`Unsafe or fractional timing or IDs in instruction ${op.id}.`);
    }
    if ((end !== null && (end < op.fetchedCycle || !Number.isSafeInteger(end - op.fetchedCycle))) ||
        stages.some((stage) => stage.end !== null &&
            (stage.end < stage.begin || !Number.isSafeInteger(stage.end - stage.begin)))) {
        throw new Error(`Reversed or overflowing timing intervals in instruction ${op.id}.`);
    }
    return { id: op.id, gid: op.gid, rid: incomplete ? null : op.rid, thread: op.tid === -1 ? null : op.tid,
        label: op.labelName, detail: op.labelDetail, begin: op.fetchedCycle, end,
        status: incomplete ? "incomplete" : op.flush ? "flushed" : "retired",
        source: { file: source, line: op.line }, stages };
}

export async function inspectCliTrace(input: TraceInput, source = input.name,
    options: CliLoadOptions = {}): Promise<CliTrace> {
    const store = new InspectionOpStore();
    const closed = new WeakSet<Stage>();
    const progress = (value: number) => options.onProgress?.(Math.min(0.9, value * 0.9));
    let format: "kanata" | "gem5" = "kanata";
    const converted = new Map<number, CliInstruction>();
    let begin = Infinity;
    let observed = 0;
    const metadata = (trace: ParsedTrace) => {
        const end = observed + 1;
        if (!Number.isSafeInteger(end)) throw new Error("The trace cycle range exceeds the safe integer range.");
        return { format, source, range: { begin: Number.isFinite(begin) ? begin : trace.lastCycle, end },
            warnings: trace.warningCount > 0 ? [`${trace.warningCount} parser warnings; details were written to stderr.`] : [],
            warningCount: trace.warningCount };
    };
    const update = (trace: ParsedTrace) => {
        options.signal?.throwIfAborted();
        const changed: CliInstruction[] = [];
        for (const id of store.changed) {
            const op = instruction(store.ops.get(id)!, trace, format, source, closed);
            converted.set(id, op);
            changed.push(op);
            begin = Math.min(begin, op.begin);
            observed = Math.max(observed, op.begin, op.end ?? op.begin);
            for (const stage of op.stages) observed = Math.max(observed, stage.end ?? stage.begin);
        }
        store.changed.clear();
        if (format === "kanata") observed = Math.max(observed, trace.lastCycle);
        options.onUpdate?.({ ...metadata(trace), instructions: changed });
    };
    try {
        options.signal?.throwIfAborted();
        let trace;
        try {
            trace = await new OnikiriParser(store, closed).parse(new InspectionLineReader(input, options.onUpdate !== undefined),
                progress, update, options.signal);
        }
        catch (error) {
            if (!(error instanceof Error) || error.message !== "The selected file is not a Kanata trace.") throw error;
            options.signal?.throwIfAborted();
            format = "gem5";
            const parser = new Gem5O3PipeViewParser(store, (message) => console.error(message));
            trace = await parser.parse(new InspectionLineReader(input, options.onUpdate !== undefined), progress, update, options.signal);
            if (parser.ticksPerClock <= 0) {
                throw new Error("Not enough completed gem5 timing data to determine ticks per clock.");
            }
        }
        options.signal?.throwIfAborted();
        const instructions = [...converted.values()];
        instructions.sort((a, b) => a.begin - b.begin || a.id - b.id);
        const result = metadata(trace);
        const unfinished = instructions.filter((op) => op.end === null).length;
        if (unfinished > 0) {
            result.warnings.push(`${unfinished} instructions are incomplete at EOF; end times are unknown.`);
        }
        return { ...result, instructions };
    }
    finally {
        store.close();
    }
}
