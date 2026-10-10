/**
 * Nodeのファイル入力と共有Parserを、CLI用の読取り専用データへつなぐ境界。
 * 展開・行読込み・Kanata解析はcoreを再利用し、絶対cycle変換と整数検査だけをCLI側で行う。
 * 疎なIDを一時storeへ保持し、EOFの表示用終端を除いて未知の終了をnullとして返す。
 * sessionの表示位置・検索・出力形式は扱わず、現段階では1ログを全量memoryへ読み込む。
 */
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";

import { FileLineReader, type ProgressCallback, type TraceInput } from "../core/file_line_reader";
import type { Op, Stage } from "../core/model";
import { OnikiriParser } from "../core/onikiri_parser";
import type { MutableOpStore } from "../core/op_store";
import type { CliInstruction, CliTrace } from "./session";

// CLI固有の整数契約と絶対cycleを入力側で処理し、共有Parserの設定分岐を増やさない。
class InspectionLineReader extends FileLineReader {
    override async readLines(
        onLine: (line: string) => void,
        onProgress?: ProgressCallback,
        signal?: AbortSignal,
    ): Promise<void> {
        let cycle = 0;
        let lineNumber = 0;
        await super.readLines((line) => {
            lineNumber++;
            // 形式の受理と不正commandの扱いは共有Parserへ任せる。
            if (lineNumber === 1 && !/^Kanata/.test(line)) {
                onLine(line);
                return;
            }
            const args = line.split("\t");
            const command = args[0];
            const integer = (text: string): number => {
                const normalized = text.trim();
                const value = Number(normalized);
                if (!/^[+-]?\d+$/.test(normalized) || !Number.isSafeInteger(value)) {
                    throw new Error(`Unsafe or invalid integer at line ${lineNumber}: ${text}`);
                }
                return value;
            };
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
        }, onProgress, signal);
    }
}

// 疎なIDを全走査せず、入力に現れた命令だけ保持する小規模調査向けstore。
class InspectionOpStore implements MutableOpStore {
    readonly ops = new Map<number, Op>();
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
        this.lastID = Math.max(this.lastID, id);
    }
    setRetiredOp(rid: number, op: Op): void {
        this.retired.set(rid, op.id);
        this.lastRID = Math.max(this.lastRID, rid);
    }
    close(): void {
        this.ops.clear();
        this.retired.clear();
    }
}

export async function loadCliTrace(filePath: string): Promise<CliTrace> {
    const source = path.resolve(filePath);
    const info = await stat(source);
    if (!info.isFile()) {
        throw new Error("The trace path must refer to a regular file.");
    }
    const input: TraceInput = {
        name: path.basename(source),
        size: info.size,
        type: "",
        stream: () => Readable.toWeb(createReadStream(source)) as ReadableStream<Uint8Array>,
    };
    return inspectCliTrace(input, source);
}

// ParserはGUIと共有するが、EOFの表示用retiredCycleを記録された終了として公開しない。
export async function inspectCliTrace(input: TraceInput, source = input.name): Promise<CliTrace> {
    const store = new InspectionOpStore();
    const closed = new WeakSet<Stage>();
    const warnings: string[] = [];
    try {
        const trace = await new OnikiriParser(store, closed).parse(new InspectionLineReader(input));
        const instructions: CliInstruction[] = [];
        for (const op of store.ops.values()) {
            const stages = op.lanes.flatMap((lane, laneID) => lane?.stages.map((stage) => ({
                lane: trace.laneNames[laneID],
                name: stage.name,
                label: stage.labels,
                begin: stage.startCycle,
                end: closed.has(stage) ? stage.endCycle : null,
            })) ?? []);
            const end = op.eof ? null : op.retiredCycle;
            if ((end !== null && (end < op.fetchedCycle || !Number.isSafeInteger(end - op.fetchedCycle))) ||
                stages.some((stage) => stage.end !== null &&
                    (stage.end < stage.begin || !Number.isSafeInteger(stage.end - stage.begin)))) {
                throw new Error(`Reversed or overflowing timing intervals in instruction ${op.id}.`);
            }
            instructions.push({
                id: op.id,
                gid: op.gid,
                rid: op.eof ? null : op.rid,
                thread: op.tid === -1 ? null : op.tid,
                label: op.labelName,
                detail: op.labelDetail,
                begin: op.fetchedCycle,
                end,
                status: op.eof ? "incomplete" : op.flush ? "flushed" : "retired",
                source: { file: source, line: op.line },
                stages,
            });
        }
        instructions.sort((a, b) => a.begin - b.begin || a.id - b.id);
        const begin = instructions[0]?.begin ?? trace.lastCycle;
        const end = Math.max(trace.lastCycle, instructions.at(-1)?.begin ?? begin) + 1;
        if (!Number.isSafeInteger(end)) {
            throw new Error("The trace cycle range exceeds the safe integer range.");
        }
        if (trace.warningCount > 0) {
            warnings.push(`${trace.warningCount} parser warnings; details were written to stderr.`);
        }
        const unfinished = instructions.filter((op) => op.end === null).length;
        if (unfinished > 0) {
            warnings.push(`${unfinished} instructions are incomplete at EOF; end times are unknown.`);
        }
        return {
            source,
            instructions,
            range: { begin, end },
            warnings,
            warningCount: trace.warningCount,
        };
    }
    finally {
        store.close();
    }
}
