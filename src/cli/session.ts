export interface CliStage {
    readonly lane: string;
    readonly name: string;
    readonly label: string;
    readonly begin: number;
    readonly end: number | null;
}

export interface CliInstruction {
    readonly id: number;
    readonly gid: number;
    readonly rid: number | null;
    readonly thread: number | null;
    readonly label: string;
    readonly detail: string;
    readonly begin: number;
    readonly end: number | null;
    readonly status: "retired" | "flushed" | "incomplete";
    readonly source: { readonly file: string; readonly line: number };
    readonly stages: readonly CliStage[];
}

export interface CliTrace {
    readonly source: string;
    readonly instructions: readonly CliInstruction[];
    readonly range: { readonly begin: number; readonly end: number };
    readonly warnings: readonly string[];
    readonly warningCount: number;
}

export interface CliState {
    file: string | null;
    range: { begin: number; end: number } | null;
    window: { begin: number; end: number };
    cyclesPerColumn: number;
    columns: number;
    rowOffset: number;
    rowLimit: number;
    selectedID: number | null;
    filters: { thread?: number };
    instructionCount: number;
    warningCount: number;
}

export interface CliRow {
    id: number;
    gid: number;
    rid: number | null;
    thread: number | null;
    label: string;
    status: CliInstruction["status"];
    begin: number;
    end: number | null;
    selected: boolean;
    continuesBefore: boolean;
    continuesAfter: boolean;
    cells: string[];
}

export type CliResult =
    | { kind: "status"; attributes?: string[] }
    | { kind: "timeline"; rows: CliRow[]; totalRows: number }
    | { kind: "selection"; id: number; label: string; hiddenByFilter: boolean }
    | { kind: "detail"; instruction: Omit<CliInstruction, "stages">;
        stages: (CliStage & { duration: number | null })[]; totalStages: number; nextStageOffset: number | null }
    | { kind: "help"; commands: readonly string[] }
    | { kind: "quit" };

export interface CliResponse {
    schemaVersion: 1;
    command: string;
    ok: boolean;
    state: CliState;
    result: CliResult | null;
    error: { code: string; message: string } | null;
    warnings: string[];
    truncated: boolean;
    nextRow: number | null;
}

export const CLI_HELP = [
    'open "path/to/trace.log"       Open one Kanata trace (plain, gzip or Zstandard)',
    "show [row-offset]              Show overlapping instructions (24 rows, 32 columns)",
    "goto cycle N                  Move the left edge to cycle N",
    "goto id|gid|rid N              Select an instruction and move to its beginning",
    "select [id|gid|rid] N          Select without moving the window (default: id)",
    "pan N                         Move by N cycles",
    "rows N                        Move by N rows within the current window",
    "zoom N                        Set positive integer cycles per column",
    "filter thread N | filter clear",
    'find "text"                   Find a case-sensitive label from the current position',
    "find stage NAME min N         Find a closed stage lasting at least N cycles",
    "next | prev                   Repeat the last search without wrapping",
    "detail [stage-offset]         Show selected instruction and up to 256 stages",
    "status | help | quit",
    "Notes: C= uses absolute log cycles; rows are ordered by start cycle, then file-local ID.",
    "Unknown ends remain null; unfinished stages are drawn only through the observed input.",
    "This prototype keeps one log in memory; gem5, PC extraction and automatic diagnosis are not supported.",
    "Integers outside the JavaScript safe integer range are rejected, never rounded.",
] as const;

class CommandError extends Error {
    constructor(readonly code: string, message: string) { super(message); }
}

function fail(code: string, message: string): never { throw new CommandError(code, message); }

function integer(text: string, positive = false): number {
    const value = Number(text);
    if (!/^[+-]?\d+$/.test(text) || !Number.isSafeInteger(value) || (positive && value <= 0)) {
        fail("invalid_number", `Expected ${positive ? "a positive" : "a safe"} integer: ${text}`);
    }
    return value;
}

function safe(value: number): number {
    if (!Number.isSafeInteger(value)) fail("overflow", "The command exceeds the safe integer range.");
    return value;
}

// shellへ渡さず文字列を分割する。Windows pathのbackslashも、引用符のescape以外は保持する。
export function tokenizeCommand(command: string): string[] {
    const tokens: string[] = [];
    let token = "";
    let quote = "";
    let started = false;
    for (let index = 0; index < command.length; index++) {
        const character = command[index];
        if (quote !== "") {
            if (character === quote) quote = "";
            else if (character === "\\" && (command[index + 1] === quote || command[index + 1] === "\\")) {
                token += command[++index];
            }
            else token += character;
        }
        else if (character === '"' || character === "'") { quote = character; started = true; }
        else if (/\s/.test(character)) {
            if (started) { tokens.push(token); token = ""; started = false; }
        }
        else { token += character; started = true; }
    }
    if (quote !== "") fail("invalid_command", "Unterminated quoted argument.");
    if (started) tokens.push(token);
    return tokens;
}

interface IntervalNode {
    readonly index: number;
    readonly maximumEnd: number;
    readonly left: IntervalNode | null;
    readonly right: IntervalNode | null;
}

// 開始時刻の二分探索だけでは、左で始まった長い命令が抜ける。部分木の最大終端で枝刈りする。
function buildIntervals(ops: readonly CliInstruction[], observedEnd: number, first = 0, end = ops.length): IntervalNode | null {
    if (first === end) return null;
    const index = Math.floor((first + end) / 2);
    const left = buildIntervals(ops, observedEnd, first, index);
    const right = buildIntervals(ops, observedEnd, index + 1, end);
    const op = ops[index];
    let maximumEnd = Math.max(op.end ?? observedEnd, op.begin + 1);
    // 命令の半開区間の右端でS/Rが重なる場合も、そのcycleの点eventを索引へ含める。
    for (const stage of op.stages) {
        if (stage.begin === stage.end) maximumEnd = Math.max(maximumEnd, stage.begin + 1);
    }
    return {
        index, left, right,
        maximumEnd: Math.max(maximumEnd,
            left?.maximumEnd ?? -Infinity, right?.maximumEnd ?? -Infinity),
    };
}

function overlaps(start: number, end: number | null, begin: number, finish: number): boolean {
    // 0長stageは点eventとして、左端を含み右端を含まない窓に載せる。
    return end === start ? begin <= start && start < finish : start < finish && (end === null || end > begin);
}

type Search = { kind: "label"; text: string } | { kind: "stage"; name: string; minimum: number };

export class CliSession {
    private trace_: CliTrace | null = null;
    private intervals_: IntervalNode | null = null;
    private ids_ = new Map<number, number>();
    private gids_ = new Map<number, number[]>();
    private rids_ = new Map<number, number[]>();
    private search_: Search | null = null;
    private state_: CliState = {
        file: null, range: null, window: { begin: 0, end: 32 }, cyclesPerColumn: 1,
        columns: 32, rowOffset: 0, rowLimit: 24, selectedID: null, filters: {},
        instructionCount: 0, warningCount: 0,
    };

    constructor(private readonly load_: (path: string) => Promise<CliTrace>) {}

    get state(): CliState {
        return { ...this.state_, window: { ...this.state_.window },
            range: this.state_.range === null ? null : { ...this.state_.range }, filters: { ...this.state_.filters } };
    }

    async execute(command: string): Promise<CliResponse> {
        const previous = this.state;
        const previousSearch = this.search_;
        const response: CliResponse = {
            schemaVersion: 1, command, ok: true, state: previous, result: null, error: null,
            warnings: [], truncated: false, nextRow: null,
        };
        try {
            const args = tokenizeCommand(command);
            response.result = await this.dispatch_(args, response);
        }
        catch (error) {
            this.state_ = previous;
            this.search_ = previousSearch;
            response.ok = false;
            response.error = { code: error instanceof CommandError ? error.code : "read_error",
                message: error instanceof Error ? error.message : String(error) };
        }
        response.state = this.state;
        return response;
    }

    private requireTrace_(): CliTrace {
        return this.trace_ ?? fail("no_trace", 'Open a trace first with open "path".');
    }

    private count_(args: string[], count: number): void {
        if (args.length !== count) fail("invalid_command", "Invalid arguments; use help for command syntax.");
    }

    private async dispatch_(args: string[], response: CliResponse): Promise<CliResult> {
        const name = args[0];
        if (name === "help" || name === "quit") {
            this.count_(args, 1);
            return name === "help" ? { kind: "help", commands: CLI_HELP } : { kind: "quit" };
        }
        if (name === "open") {
            this.count_(args, 2);
            // 成功するまで既存のsessionを触らず、失敗したopenでも調査位置を失わない。
            const trace = await this.load_(args[1]);
            const intervals = buildIntervals(trace.instructions, trace.range.end);
            const ids = new Map<number, number>();
            const gids = new Map<number, number[]>();
            const rids = new Map<number, number[]>();
            trace.instructions.forEach((op, index) => {
                ids.set(op.id, index);
                for (const [map, key] of [[gids, op.gid], [rids, op.status === "retired" ? op.rid : null]] as const) {
                    if (key !== null) {
                        const bucket = map.get(key);
                        if (bucket === undefined) map.set(key, [index]);
                        else bucket.push(index);
                    }
                }
            });
            const windowEnd = safe(Math.min(Number.MAX_SAFE_INTEGER, trace.range.begin + 32));
            this.trace_ = trace;
            this.intervals_ = intervals;
            this.ids_ = ids; this.gids_ = gids; this.rids_ = rids;
            this.search_ = null;
            this.state_ = {
                file: trace.source, range: { ...trace.range }, window: { begin: trace.range.begin, end: windowEnd },
                cyclesPerColumn: 1, columns: 32, rowOffset: 0, rowLimit: 24, selectedID: null, filters: {},
                instructionCount: trace.instructions.length, warningCount: trace.warningCount,
            };
            response.warnings.push(...trace.warnings);
            return { kind: "status", attributes: ["id", "gid", "rid", "label", "lane", "stage",
                ...(trace.instructions.some((op) => op.thread !== null) ? ["thread"] : [])] };
        }
        const trace = this.requireTrace_();
        switch (name) {
        case "status":
            this.count_(args, 1);
            return { kind: "status" };
        case "show":
            if (args.length === 2) {
                const offset = integer(args[1]);
                if (offset < 0) fail("invalid_number", "Row offsets cannot be negative.");
                this.state_.rowOffset = offset;
            }
            else this.count_(args, 1);
            return this.timeline_(response);
        case "goto":
        case "select": {
            const [kind, value] = name === "select" && args.length === 2 ? ["id", args[1]] : [args[1], args[2]];
            this.count_(args, name === "select" && args.length === 2 ? 2 : 3);
            if (kind === "cycle" && name === "goto") {
                this.move_(integer(value));
                return this.timeline_(response);
            }
            const op = this.lookup_(kind, integer(value));
            this.state_.selectedID = op.id;
            const hiddenByFilter = !this.matchesFilter_(op);
            if (hiddenByFilter) response.warnings.push(`Instruction ${op.id} is hidden by the current filter.`);
            if (name === "goto") {
                this.move_(op.begin);
                return this.timeline_(response);
            }
            return { kind: "selection", id: op.id, label: op.label, hiddenByFilter };
        }
        case "pan":
            this.count_(args, 2);
            this.move_(Math.max(trace.range.begin, safe(this.state_.window.begin + integer(args[1]))));
            return this.timeline_(response);
        case "zoom": {
            this.count_(args, 2);
            const scale = integer(args[1], true);
            safe(scale * this.state_.columns);
            this.state_.cyclesPerColumn = scale;
            this.move_(this.state_.window.begin);
            return this.timeline_(response);
        }
        case "rows":
            this.count_(args, 2);
            this.state_.rowOffset = Math.max(0, safe(this.state_.rowOffset + integer(args[1])));
            return this.timeline_(response);
        case "filter":
            if (args.length === 2 && args[1] === "clear") this.state_.filters = {};
            else {
                this.count_(args, 3);
                if (args[1] !== "thread") fail("unsupported_attribute", "Only the recorded thread attribute is supported; PC, opcode and placement are free-form labels.");
                if (!trace.instructions.some((op) => op.thread !== null)) {
                    fail("unsupported_attribute", "This log has no recorded thread IDs.");
                }
                this.state_.filters = { thread: integer(args[2]) };
            }
            this.state_.rowOffset = 0;
            return this.timeline_(response);
        case "find": {
            if (args.length === 5 && args[1] === "stage" && args[3] === "min") {
                const minimum = integer(args[4]);
                if (minimum < 0) fail("invalid_number", "The minimum duration cannot be negative.");
                this.search_ = { kind: "stage", name: args[2], minimum };
            }
            else {
                this.count_(args, 2);
                if (args[1] === "") fail("invalid_command", "Search text cannot be empty.");
                this.search_ = { kind: "label", text: args[1] };
            }
            return this.find_(1, false, response);
        }
        case "next":
        case "prev":
            this.count_(args, 1);
            return this.find_(name === "next" ? 1 : -1, true, response);
        case "detail": {
            if (args.length !== 1 && args.length !== 2) this.count_(args, 1);
            const offset = args.length === 2 ? integer(args[1]) : 0;
            if (offset < 0) fail("invalid_number", "Stage offsets cannot be negative.");
            if (this.state_.selectedID === null) fail("no_selection", "Select an instruction first.");
            const { stages, ...instruction } = this.lookup_("id", this.state_.selectedID);
            const page = stages.slice(offset, offset + 256).map((stage) => ({ ...stage,
                duration: stage.end === null ? null : safe(stage.end - stage.begin) }));
            const nextStageOffset = offset + page.length < stages.length ? offset + page.length : null;
            response.truncated = nextStageOffset !== null;
            return { kind: "detail", instruction, stages: page, totalStages: stages.length, nextStageOffset };
        }
        default:
            fail("invalid_command", "Unknown command; use help for command syntax.");
        }
    }

    private move_(begin: number): void {
        const end = safe(begin + safe(this.state_.columns * this.state_.cyclesPerColumn));
        this.state_.window = { begin, end };
        this.state_.rowOffset = 0;
    }

    private lookup_(kind: string, value: number): CliInstruction {
        let indices: number[];
        if (kind === "id") {
            const index = this.ids_.get(value);
            indices = index === undefined ? [] : [index];
        }
        else if (kind === "gid" || kind === "rid") indices = (kind === "gid" ? this.gids_ : this.rids_).get(value) ?? [];
        else return fail("invalid_command", "Use id, gid or rid to identify an instruction.");
        if (indices.length === 0) fail("not_found", `No instruction with ${kind} ${value}.`);
        if (indices.length > 1) fail("ambiguous_id", `${kind} ${value} is not unique; use a file-local ID.`);
        return this.requireTrace_().instructions[indices[0]];
    }

    private matchesFilter_(op: CliInstruction): boolean {
        return this.state_.filters.thread === undefined || this.state_.filters.thread === op.thread;
    }

    private timeline_(response: CliResponse): CliResult {
        const trace = this.requireTrace_();
        const { begin, end } = this.state_.window;
        const matches: CliInstruction[] = [];
        const visit = (node: IntervalNode | null) => {
            if (node === null || node.maximumEnd <= begin) return;
            visit(node.left);
            const op = trace.instructions[node.index];
            if (op.begin >= end) return;
            const visible = overlaps(op.begin, op.end ?? trace.range.end, begin, end) ||
                op.stages.some((stage) => stage.begin === stage.end && overlaps(stage.begin, stage.end, begin, end));
            if (visible && this.matchesFilter_(op)) matches.push(op);
            visit(node.right);
        };
        visit(this.intervals_);
        const offset = this.state_.rowOffset;
        const page = matches.slice(offset, offset + this.state_.rowLimit);
        response.truncated = offset + page.length < matches.length;
        response.nextRow = response.truncated ? offset + page.length : null;
        return { kind: "timeline", totalRows: matches.length, rows: page.map((op) => {
            const cells: string[] = [];
            for (let column = 0; column < this.state_.columns; column++) {
                if (column >= Math.ceil((end - begin) / this.state_.cyclesPerColumn)) {
                    cells.push(".");
                    continue;
                }
                const start = begin + column * this.state_.cyclesPerColumn;
                const finish = Math.min(end, start + this.state_.cyclesPerColumn);
                if (start >= trace.range.end && op.end === null) {
                    cells.push("?");
                    continue;
                }
                const stages = op.stages.filter((stage) => overlaps(stage.begin,
                    stage.end ?? op.end ?? trace.range.end, start, finish));
                cells.push(stages.length > 1 ? "*" : stages.length === 0 ? "." :
                    `${stages[0].begin === stages[0].end ? "@" : ""}${stages[0].name}`);
            }
            return { id: op.id, gid: op.gid, rid: op.rid, thread: op.thread, label: op.label,
                status: op.status, begin: op.begin, end: op.end, selected: op.id === this.state_.selectedID,
                continuesBefore: op.begin < begin, continuesAfter: op.end === null || op.end > end, cells };
        }) };
    }

    private find_(direction: number, repeat: boolean, response: CliResponse): CliResult {
        const trace = this.requireTrace_();
        const search = this.search_ ?? fail("no_search", "Run find before next or prev.");
        const selected = this.state_.selectedID === null ? undefined : this.ids_.get(this.state_.selectedID);
        let index: number;
        if (repeat && selected !== undefined) index = selected + direction;
        else {
            // 新しい検索は、選択ではなく現在窓の左端から開始時刻順に調べる。
            let first = 0, end = trace.instructions.length;
            while (first < end) {
                const middle = Math.floor((first + end) / 2);
                if (trace.instructions[middle].begin < this.state_.window.begin) first = middle + 1;
                else end = middle;
            }
            index = direction > 0 ? first : first - 1;
        }
        for (; index >= 0 && index < trace.instructions.length; index += direction) {
            const op = trace.instructions[index];
            const found = search.kind === "label" ? op.label.includes(search.text) : op.stages.some((stage) =>
                stage.name === search.name && stage.end !== null && stage.end - stage.begin >= search.minimum);
            if (this.matchesFilter_(op) && found) {
                this.state_.selectedID = op.id;
                this.move_(op.begin);
                return this.timeline_(response);
            }
        }
        return fail("not_found", "No matching instruction in this direction; the search does not wrap.");
    }
}
