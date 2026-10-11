/**
 * CLIのデータ・応答契約と、1ログに対する対話状態・command処理をまとめる。
 * 時間窓、倍率、行位置、filter、検索条件と検索cursor、索引を保持し、構造化した結果を返す。
 * 命令の調査対象はcommandごとに指定し、暗黙の選択状態には依存させない。
 * ファイル読込みは注入された関数へ任せ、Nodeの入出力・端末幅・GUIには依存しない。
 * テキスト表示とJSON Linesの両方がこの同じ処理を使い、表示方式による操作差を作らない。
 */

// loaderから受け取る記録値。区間は原則[begin, end)、nullは未記録の終了を表す。
// begin=endのstageは点eventとして扱い、GUIの表示用幅を実際の滞在時間へ持ち込まない。
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
    readonly format?: "kanata" | "gem5";
    readonly source: string;
    readonly instructions: readonly CliInstruction[];
    readonly range: { readonly begin: number; readonly end: number };
    readonly warnings: readonly string[];
    readonly warningCount: number;
}

// 途中通知は変更された命令だけを運ぶ。全命令のコピーや再索引を更新ごとに繰り返さない。
export type CliTraceUpdate = Omit<CliTrace, "instructions"> & {
    readonly instructions: readonly CliInstruction[];
};

// loaderのcancel／進捗／部分結果を共有し、Nodeのstreamや端末をsessionへ持ち込まない。
export interface CliLoadOptions {
    readonly signal?: AbortSignal;
    readonly onProgress?: (progress: number) => void;
    readonly onUpdate?: (update: CliTraceUpdate) => void;
}

export interface CliLoadingState {
    file: string;
    status: "loading" | "ready" | "failed" | "canceled";
    progress: number;
    error: { code: string; message: string } | null;
}

export interface CliState {
    file: string | null;
    format: "kanata" | "gem5" | null;
    loading: CliLoadingState | null;
    range: { begin: number; end: number } | null;
    window: { begin: number; end: number };
    cyclesPerColumn: number;
    columns: number;
    rowOffset: number;
    rowLimit: number;
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
    continuesBefore: boolean;
    continuesAfter: boolean;
    cells: string[];
}

// 命令ID順の各群から中央の1命令を代表として描く。件数は群全体、寿命は代表だけの値。
export interface CliOverviewRow {
    firstID: number;
    lastID: number;
    instructionCount: number;
    retired: number;
    flushed: number;
    incomplete: number;
    representative: Pick<CliInstruction, "id" | "gid" | "rid" | "thread" | "status" | "begin" | "end"> & {
        duration: number | null;
    };
    cells: string[];
}

// 集計対象と分母を応答に残し、時間窓や読込み後の更新によって結果の意味を変えない。
export interface CliCountResult {
    kind: "count";
    scope: { source: string; idRange: { first: number; last: number } | null; thread: number | null; complete: boolean };
    condition: { stage: string; minimumDuration: number };
    totalInstructions: number;
    matchedInstructions: number;
    percentage: number | null;
    unfinishedInstructions: number;
    maximumDuration: number | null;
    groupBy: "pc" | null;
    groups: { pc: string | null; count: number; maximumDuration: number }[];
    totalGroups: number;
    top: number | null;
}

export type CliResult =
    | { kind: "status"; attributes?: string[] }
    | { kind: "timeline"; rows: CliRow[]; totalRows: number; matchID?: number }
    | { kind: "overview"; rows: CliOverviewRow[]; totalInstructions: number;
        axis: { begin: number; end: number; cyclesPerColumn: number } | null }
    | CliCountResult
    | { kind: "detail"; instruction: Omit<CliInstruction, "stages">;
        stages: (CliStage & { duration: number | null })[]; stageFilter: string | null;
        totalStages: number; nextStageOffset: number | null }
    | { kind: "help"; commands: readonly string[] }
    | { kind: "quit" };

// 出力方式共通の応答。表示結果だけでなく、状態・失敗理由・省略と続きの位置も返す。
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
    "Konata CLI commands",
    "Use help COMMAND for full syntax and examples. [] = optional; | = alternatives.",
    "",
    "Load:",
    '  open [--sync] "path"         Open Kanata/gem5 (plain, gzip or Zstandard)',
    "  wait | cancel                Finish or stop a background load",
    "",
    "View:",
    "  show [row-offset]            Timeline in the current window",
    "  overview [first-id last-id]  Sample lifetimes across an instruction ID range",
    "  detail N ...                 Inspect an instruction without moving (help detail)",
    "",
    "Move:",
    "  goto cycle N                 Set the left edge of the time window",
    "  goto id|gid|rid N            Move to an instruction's beginning",
    "  pan N | rows N               Move by cycles or rows; negative N moves back",
    "  zoom N                       Set cycles per column (positive integer)",
    "",
    "Filter and search:",
    "  filter thread N              Keep only this thread; filter clear resets it",
    '  find "text"                  Search labels (case-sensitive)',
    "  find stage NAME min N        Find a closed stage lasting at least N cycles",
    "  next | prev                  Repeat the last search without wrapping",
    "",
    "Count:",
    "  count instructions ...       Count stage-duration matches (help count)",
    "",
    "Session:",
    "  status                       Show the view, filter and loading progress",
    "  help [command] | quit        Show help or exit",
    "",
    "Loading is background by default; commands use available data. Use wait for the full log.",
    "Interactive input: Tab completes commands and arguments; Up/Down recalls history.",
    "Numbers must be safe integers; unrecorded ends stay unknown. No automatic diagnosis.",
] as const;

// 一覧は用途別の入口、個別helpは構文・例・詳細条件を示す。先頭のusageは引数errorと共有する。
// 補完にも個別helpのcommand一覧を使い、command名のずれを防ぐ。
const COMMAND_HELP = {
    open: ['Usage: open [--sync] "path/to/trace.log"',
        "",
        "Detect Kanata or gem5 O3PipeView (plain, gzip or Zstandard).",
        "",
        "Examples:",
        '  open "trace.log.zst"',
        '  open --sync "trace.log"',
        "",
        "Loading:",
        "  Background by default; commands can use instructions already published by the parser.",
        "  --sync waits for completion before returning (useful in scripts).",
        "  status shows progress; wait finishes loading; cancel stops it. A new open cancels the old load.",
        "",
        "View and data:",
        "  First publication replaces the old trace and resets the view; later updates preserve it.",
        "  Cancellation or failure keeps published data; before publication the old trace is preserved.",
        "  gem5 uses GUI-relative cycles/stage names; raw ticks remain in details; missing threads use 0."],
    wait: ["Usage: wait", "Wait for the latest background load, including indexing. Report loading errors."],
    cancel: ["Usage: cancel", "Stop loading and keep the available instructions and inspection state."],
    show: ["Usage: show [row-offset]",
        "Show instructions overlapping the current window, up to 24 rows and 32 columns.",
        "Order is start cycle, then ID; C= timestamps use absolute log cycles.",
        "Unfinished stages extend only through observed input; unrecorded ends stay unknown.",
        "Use the reported row offset to read the next page."],
    overview: ["Usage: overview [first-id last-id]",
        "",
        "Sample instruction lifetimes on one shared, non-wrapping time axis.",
        "",
        "Examples:",
        "  overview",
        "  overview 0 999",
        "",
        "Scope:",
        "  All available instructions, or an inclusive file-local ID range; the thread filter applies.",
        "  The window, zoom and search cursor are unchanged.",
        "",
        "Display:",
        "  At most 24 equal-count groups in ID order; the middle instruction represents each group.",
        "  32 columns span the earliest sampled fetch to the latest sampled end; bars never wrap.",
        "  Short and zero-duration lifetimes occupy at least one cell; exact times appear alongside.",
        "  Counts cover entire groups; lifetimes are samples, not averages or maxima.",
        "  Unrecorded ends stay unknown; unfinished bars extend only through observed input."],
    count: ["Usage: count instructions [range id FIRST LAST] where stage NAME duration >= N [group by pc [top N]]",
        "",
        "Count instructions with a matching closed stage interval. This is fixed syntax, not SQL.",
        "",
        "Examples:",
        "  count instructions where stage EX duration >= 5",
        "  count instructions range id 1000 1999 where stage EX duration >= 5 group by pc top 10",
        "",
        "Scope:",
        "  Default: all available instructions, not the visible window; the thread filter applies.",
        "  range id FIRST LAST: inclusive nonnegative file-local IDs.",
        "  While loading, use the published snapshot; results mark input as complete or partial.",
        "  The window, zoom and search cursor are unchanged.",
        "",
        "Condition and totals:",
        "  Match the exact, case-sensitive stage name and an interval of at least N cycles (N >= 0).",
        "  Count each matching instruction once; the percentage denominator is all scoped instructions.",
        "  Maximum duration uses matching closed intervals; reentries and parallel lanes are not summed.",
        "  Count instructions with unfinished intervals separately; do not invent ends or durations.",
        "  An instruction with both matching closed and unfinished intervals appears in both counts.",
        "",
        "PC ranking (optional):",
        "  group by pc: rank matches by count, then numeric PC; unknown PCs form a separate group.",
        "  Only leading 0x hexadecimal addresses followed by whitespace, a colon or label end are PCs.",
        "  top N: show 1-256 groups (default 10); omitted groups do not change the totals."],
    goto: ["Usage: goto cycle N | goto id|gid|rid N",
        "Move the window to cycle N, or to an instruction's beginning. The search cursor is unchanged.",
        "id is file-local, gid is the log's global ID, and rid is the retired instruction number.",
        "Example: goto id 413"],
    pan: ["Usage: pan N", "Move the window by N cycles; negative values move backwards.", "Example: pan -20"],
    rows: ["Usage: rows N", "Move by N rows within the current window; negative values move backwards."],
    zoom: ["Usage: zoom N", "Set a positive integer number of cycles per column. The window has 32 columns."],
    filter: ["Usage: filter thread N | filter clear",
        "Filter by a recorded thread ID, or clear the filter. Other attributes are not supported yet."],
    find: ['Usage: find "text" | find stage NAME min N',
        "Find a case-sensitive label, or a closed stage lasting at least N cycles.",
        "Start at the current window's left edge and follow the current filter; do not wrap.",
        "Order is start cycle, then ID.",
        'Examples: find "dload4"; find stage ID min 3',
        "Use next or prev to repeat the last successful search."],
    next: ["Usage: next", "Repeat the last search forwards from its last match, without wrapping."],
    prev: ["Usage: prev", "Repeat the last search backwards from its last match, without wrapping."],
    detail: ["Usage: detail [id|gid|rid] N [stage NAME] [stage-offset]",
        "",
        "Show the specified instruction's complete label and up to 256 stage intervals.",
        "",
        "Examples:",
        "  detail 413",
        "  detail gid 120",
        "  detail id 413 stage EX",
        "  detail id 413 stage EX 256",
        "",
        "Instruction:",
        "  Default: file-local id. gid is the log's global ID; rid is the retired instruction number.",
        "  The window and search cursor are unchanged; thread-hidden instructions can be inspected.",
        "",
        "Stages:",
        "  stage NAME matches an exact, case-sensitive name; reentries and parallel lanes stay separate.",
        "  stage-offset skips matching intervals (all intervals if no stage is specified).",
        "  No matches returns an empty list; unrecorded ends and durations stay unknown."],
    status: ["Usage: status", "Show the trace, window, scale, filters and latest load progress or error."],
    help: ["Usage: help [command]", "List commands, or show help for one command.", "Example: help find"],
    quit: ["Usage: quit", "Cancel any pending load and exit. EOF waits for pending loading before exiting."],
} as const;

export const CLI_COMMAND_NAMES: readonly string[] = Object.keys(COMMAND_HELP);

function commandHelp(name: string): readonly string[] | undefined {
    return Object.hasOwn(COMMAND_HELP, name) ? COMMAND_HELP[name as keyof typeof COMMAND_HELP] : undefined;
}

export interface CliCompletionValues {
    readonly stages: readonly string[];
    readonly threads: readonly string[];
}

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

// 入力途中の引用符も扱い、補完対象の生文字列の位置を返す。実行時の検査はtokenizeCommandで行う。
// shellへ渡さず分割し、Windows pathのbackslashも引用符のescape以外は保持する。
export function scanCommandInput(command: string) {
    const tokens: string[] = [];
    let token = "";
    let quote = "";
    let started = false;
    let start = 0;
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
            start = index + 1;
        }
        else { token += character; started = true; }
    }
    return { tokens, active: { value: token, start, quote, started } };
}

export function tokenizeCommand(command: string): string[] {
    const { tokens, active } = scanCommandInput(command);
    if (active.quote !== "") fail("invalid_command", "Unterminated quoted argument.");
    if (active.started) tokens.push(active.value);
    return tokens;
}

interface IntervalNode {
    index: number;
    begin: number;
    id: number;
    ownEnd: number;
    maximumEnd: number;
    height: number;
    left: IntervalNode | null;
    right: IntervalNode | null;
}

// 開始時刻の二分探索だけでは、左で始まった長い命令が抜ける。部分木の最大終端で枝刈りする。
// 未完了の終端は索引内だけInfinityとし、観測範囲の伸長ごとに全nodeを更新しない。
function intervalNode(index: number, op: CliInstruction): IntervalNode {
    let ownEnd = Math.max(op.end ?? Infinity, op.begin + 1);
    for (const stage of op.stages) {
        if (stage.begin === stage.end) ownEnd = Math.max(ownEnd, stage.begin + 1);
    }
    return { index, begin: op.begin, id: op.id, ownEnd, maximumEnd: ownEnd,
        height: 1, left: null, right: null };
}

function refreshInterval(node: IntervalNode): IntervalNode {
    node.height = 1 + Math.max(node.left?.height ?? 0, node.right?.height ?? 0);
    node.maximumEnd = Math.max(node.ownEnd, node.left?.maximumEnd ?? -Infinity, node.right?.maximumEnd ?? -Infinity);
    return node;
}

function rotateInterval(node: IntervalNode, left: boolean): IntervalNode {
    const root = (left ? node.right : node.left)!;
    if (left) { node.right = root.left; root.left = refreshInterval(node); }
    else { node.left = root.right; root.right = refreshInterval(node); }
    return refreshInterval(root);
}

function balanceInterval(node: IntervalNode): IntervalNode {
    refreshInterval(node);
    const difference = (node.left?.height ?? 0) - (node.right?.height ?? 0);
    if (difference > 1) {
        if ((node.left!.left?.height ?? 0) < (node.left!.right?.height ?? 0)) {
            node.left = rotateInterval(node.left!, true);
        }
        return rotateInterval(node, false);
    }
    if (difference < -1) {
        if ((node.right!.right?.height ?? 0) < (node.right!.left?.height ?? 0)) {
            node.right = rotateInterval(node.right!, false);
        }
        return rotateInterval(node, true);
    }
    return node;
}

function comparePosition(a: { begin: number; id: number }, b: { begin: number; id: number }): number {
    return a.begin - b.begin || a.id - b.id;
}

// AVL区間索引を差分更新する。時刻順でない追加、同じ命令の後続ラベル更新にも対応する。
function insertInterval(root: IntervalNode | null, node: IntervalNode): IntervalNode {
    if (root === null) return node;
    if (comparePosition(node, root) < 0) root.left = insertInterval(root.left, node);
    else root.right = insertInterval(root.right, node);
    return balanceInterval(root);
}

function removeInterval(root: IntervalNode | null, key: { begin: number; id: number }): IntervalNode | null {
    if (root === null) return null;
    const order = comparePosition(key, root);
    if (order < 0) root.left = removeInterval(root.left, key);
    else if (order > 0) root.right = removeInterval(root.right, key);
    else {
        if (root.left === null) return root.right;
        if (root.right === null) return root.left;
        let next = root.right;
        while (next.left !== null) next = next.left;
        root.index = next.index; root.begin = next.begin; root.id = next.id; root.ownEnd = next.ownEnd;
        root.right = removeInterval(root.right, next);
    }
    return balanceInterval(root);
}

function buildIntervals(ops: readonly CliInstruction[], first = 0, end = ops.length): IntervalNode | null {
    if (first === end) return null;
    const index = Math.floor((first + end) / 2);
    const node = intervalNode(index, ops[index]);
    node.left = buildIntervals(ops, first, index);
    node.right = buildIntervals(ops, index + 1, end);
    return refreshInterval(node);
}

function overlaps(start: number, end: number | null, begin: number, finish: number): boolean {
    // 0長stageは点eventとして、左端を含み右端を含まない窓に載せる。
    return end === start ? begin <= start && start < finish : start < finish && (end === null || end > begin);
}

// 自由ラベル内の任意のhex値をPCと推定しない。Kanataの先頭addressとgem5の
// address: disassembly形式だけを読み、64bit以上のPCもNumberへ変換せず保持する。
function instructionPC(label: string): string | null {
    const address = /^\s*0x([\da-f]+)(?=\s|:|$)/i.exec(label);
    return address === null ? null : `0x${address[1].toLowerCase().replace(/^0+(?=.)/, "")}`;
}

type Search = { kind: "label"; text: string } | { kind: "stage"; name: string; minimum: number };

interface LoadJob {
    state: CliLoadingState;
    controller: AbortController;
    done: Promise<void>;
    live: boolean;
    published: boolean;
}

// 読込み済みログと索引を再利用する操作本体。失敗したcommandで直前の調査状態を失わない。
export class CliSession {
    private trace_: CliTrace | null = null;
    // 次のopenが未公開の間も、現在のtraceが全量か途中かを独立して保持する。
    private traceComplete_ = false;
    private intervals_: IntervalNode | null = null;
    private ids_ = new Map<number, number>();
    private gids_ = new Map<number, number[]>();
    private rids_ = new Map<number, number[]>();
    private completionValues_: CliCompletionValues = { stages: [], threads: [] };
    private liveInstructions_: CliInstruction[] = [];
    private liveStages_ = new Set<string>();
    private liveThreads_ = new Set<number>();
    private completionDirty_ = false;
    private loadJob_: LoadJob | null = null;
    private search_: Search | null = null;
    private searchCursorID_: number | null = null;
    private state_: Omit<CliState, "loading"> = {
        file: null, format: null, range: null, window: { begin: 0, end: 32 }, cyclesPerColumn: 1,
        columns: 32, rowOffset: 0, rowLimit: 24, filters: {},
        instructionCount: 0, warningCount: 0,
    };

    constructor(private readonly load_: (path: string, options?: CliLoadOptions) => Promise<CliTrace>) {}

    get state(): CliState {
        const loading = this.loadJob_?.state;
        return { ...this.state_, loading: loading === undefined ? null : { ...loading,
            error: loading.error === null ? null : { ...loading.error } }, window: { ...this.state_.window },
            range: this.state_.range === null ? null : { ...this.state_.range }, filters: { ...this.state_.filters } };
    }

    // 大きいログをTabごとに走査せず、差分通知で集めた候補を必要時だけ整列する。
    get completionValues(): CliCompletionValues {
        if (this.completionDirty_) {
            this.completionValues_ = { stages: Object.freeze([...this.liveStages_].sort()),
                threads: Object.freeze([...this.liveThreads_].sort((a, b) => a - b).map(String)) };
            this.completionDirty_ = false;
        }
        return this.completionValues_;
    }

    // EOFはバックグラウンド読込みの成否を待つが、command外のJSON応答は生成しない。
    async finishLoading(): Promise<void> { await this.loadJob_?.done; }

    async execute(command: string): Promise<CliResponse> {
        const previous = this.state;
        const previousSearch = this.search_;
        const previousCursor = this.searchCursorID_;
        let name = "";
        const response: CliResponse = {
            schemaVersion: 1, command, ok: true, state: previous, result: null, error: null,
            warnings: [], truncated: false, nextRow: null,
        };
        try {
            const args = tokenizeCommand(command);
            name = args[0];
            // 即時commandはawaitを挟まず、結果とstateを同じ時点で写す。途中通知がその間に
            // 別ログ／別rangeを公開して、古いshowに新しいstateが付くことを避ける。
            const result = this.dispatch_(args, response);
            response.result = result instanceof Promise ? await result : result;
        }
        catch (error) {
            // openは最初の部分結果または成功時に置換する。wait中の新open／cancelで、古いsnapshotを
            // 戻して現在のtraceや調査操作を消さない。通常の操作errorだけを巻き戻す。
            if (name !== "open" && name !== "wait") {
                const { loading: _loading, ...saved } = previous;
                this.state_ = saved;
                this.search_ = previousSearch;
                this.searchCursorID_ = previousCursor;
            }
            response.ok = false;
            response.error = { code: error instanceof CommandError ? error.code : "read_error",
                message: error instanceof Error ? error.message : String(error) };
        }
        response.state = this.state;
        return response;
    }

    private requireTrace_(): CliTrace {
        if (this.trace_ !== null) return this.trace_;
        if (this.loadJob_?.state.status === "loading") {
            fail("loading", "No instructions are available yet. Try show again as loading progresses, or use wait.");
        }
        return fail("no_trace", 'Open a trace first with open "path".');
    }

    private count_(args: string[], count: number): void {
        if (args.length !== count) {
            fail("invalid_command", `Invalid arguments. ${commandHelp(args[0])?.[0] ?? "Use help for command syntax."}`);
        }
    }

    private dispatch_(args: string[], response: CliResponse): CliResult | Promise<CliResult> {
        const name = args[0];
        if (name === "help") {
            if (args.length !== 1 && args.length !== 2) this.count_(args, 1);
            const commands = args.length === 1 ? CLI_HELP : commandHelp(args[1]);
            if (commands === undefined) fail("invalid_command", `Unknown help topic: ${args[1]}. Use help to list commands.`);
            return { kind: "help", commands };
        }
        if (name === "quit") {
            this.count_(args, 1);
            this.cancelLoad_();
            return { kind: "quit" };
        }
        if (name === "open") {
            const hasMode = args[1] === "--sync" || args[1] === "--async";
            this.count_(args, hasMode ? 3 : 2);
            const previousJob = this.loadJob_;
            this.cancelLoad_();
            const job: LoadJob = { state: { file: args[hasMode ? 2 : 1], status: "loading", progress: 0, error: null },
                controller: new AbortController(), done: Promise.resolve(), live: args[1] !== "--sync", published: false };
            this.loadJob_ = job;
            job.done = this.loadTrace_(job);
            if (args[1] !== "--sync") return { kind: "status" };
            return this.waitForLoad_(job, response).catch((error: unknown) => {
                // 従来の同期open失敗では、最新loadの表示も含めて以前の状態を保つ。
                if (this.loadJob_ === job) this.loadJob_ = previousJob;
                throw error;
            });
        }
        if (name === "status" || name === "wait" || name === "cancel") {
            this.count_(args, 1);
            if (name === "cancel") this.cancelLoad_();
            if (name === "wait" && this.loadJob_ !== null) return this.waitForLoad_(this.loadJob_, response);
            return { kind: "status" };
        }
        const trace = this.requireTrace_();
        switch (name) {
        case "show":
            if (args.length === 2) {
                const offset = integer(args[1]);
                if (offset < 0) fail("invalid_number", "Row offsets cannot be negative.");
                this.state_.rowOffset = offset;
            }
            else this.count_(args, 1);
            return this.timeline_(response);
        case "overview": {
            if (args.length !== 1 && args.length !== 3) this.count_(args, 3);
            const firstID = args.length === 3 ? integer(args[1]) : -Infinity;
            const lastID = args.length === 3 ? integer(args[2]) : Infinity;
            if (firstID > lastID) fail("invalid_number", "The first ID must not exceed the last ID.");
            return this.overview_(firstID, lastID);
        }
        case "count":
            return this.aggregate_(args, response);
        case "goto": {
            this.count_(args, 3);
            const [kind, value] = [args[1], args[2]];
            if (kind === "cycle") {
                this.move_(integer(value));
                return this.timeline_(response);
            }
            const op = this.lookup_(kind, integer(value));
            const hiddenByFilter = !this.matchesFilter_(op);
            if (hiddenByFilter) response.warnings.push(`Instruction ${op.id} is hidden by the current filter.`);
            this.move_(op.begin);
            return this.timeline_(response);
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
            const named = ["id", "gid", "rid"].includes(args[1]);
            const stageIndex = named ? 3 : 2;
            const filtered = args[stageIndex] === "stage";
            const count = stageIndex + (filtered ? 2 : 0);
            if (args.length !== count && args.length !== count + 1) this.count_(args, count);
            const stageFilter = filtered ? args[stageIndex + 1] : null;
            if (stageFilter === "") fail("invalid_command", "Stage names cannot be empty.");
            const offset = args.length === count + 1 ? integer(args[count]) : 0;
            if (offset < 0) fail("invalid_number", "Stage offsets cannot be negative.");
            const op = this.lookup_(named ? args[1] : "id", integer(args[named ? 2 : 1]));
            if (!this.matchesFilter_(op)) response.warnings.push(`Instruction ${op.id} is hidden by the current filter.`);
            const { stages, ...instruction } = op;
            // laneや再入場の区間を併合せず、対象命令内の一致区間を絞ってからpageを切る。
            const matching = stageFilter === null ? stages : stages.filter((stage) => stage.name === stageFilter);
            const page = matching.slice(offset, offset + 256).map((stage) => ({ ...stage,
                duration: stage.end === null ? null : safe(stage.end - stage.begin) }));
            const nextStageOffset = offset + page.length < matching.length ? offset + page.length : null;
            response.truncated = nextStageOffset !== null;
            return { kind: "detail", instruction, stages: page, stageFilter, totalStages: matching.length, nextStageOffset };
        }
        default:
            fail("invalid_command", "Unknown command; use help for command syntax.");
        }
    }

    private cancelLoad_(): void {
        const job = this.loadJob_;
        if (job?.state.status !== "loading") return;
        job.state.status = "canceled";
        job.controller.abort();
    }

    private async waitForLoad_(job: LoadJob, response: CliResponse): Promise<CliResult> {
        await job.done;
        if (job !== this.loadJob_ || job.state.status === "canceled") {
            fail("load_canceled", "File loading was canceled or replaced.");
        }
        if (job.state.error !== null) fail(job.state.error.code, job.state.error.message);
        response.warnings.push(...this.requireTrace_().warnings);
        return { kind: "status", attributes: ["id", "gid", "rid", "label", "lane", "stage",
            ...(this.completionValues.threads.length > 0 ? ["thread"] : [])] };
    }

    private resetView_(trace: CliTrace): void {
        this.search_ = null;
        this.searchCursorID_ = null;
        this.state_ = {
            file: trace.source, format: trace.format ?? "kanata", range: { ...trace.range },
            window: { begin: trace.range.begin, end: safe(Math.min(Number.MAX_SAFE_INTEGER, trace.range.begin + 32)) },
            cyclesPerColumn: 1, columns: 32, rowOffset: 0, rowLimit: 24, filters: {},
            instructionCount: trace.instructions.length, warningCount: trace.warningCount,
        };
    }

    private updateInstruction_(op: CliInstruction): void {
        let index = this.ids_.get(op.id);
        if (index !== undefined) {
            const previous = this.liveInstructions_[index];
            if (previous === op) return;
            this.intervals_ = removeInterval(this.intervals_, previous);
            for (const [map, key] of [[this.gids_, previous.gid],
                [this.rids_, previous.status === "retired" ? previous.rid : null]] as const) {
                if (key === null) continue;
                const remaining = map.get(key)!.filter((entry) => entry !== index);
                if (remaining.length === 0) map.delete(key);
                else map.set(key, remaining);
            }
            this.liveInstructions_[index] = op;
        }
        else {
            index = this.liveInstructions_.length;
            this.liveInstructions_.push(op);
            this.ids_.set(op.id, index);
        }
        for (const [map, key] of [[this.gids_, op.gid],
            [this.rids_, op.status === "retired" ? op.rid : null]] as const) {
            if (key === null) continue;
            const bucket = map.get(key);
            if (bucket === undefined) map.set(key, [index]);
            else bucket.push(index);
        }
        this.intervals_ = insertInterval(this.intervals_, intervalNode(index, op));
        for (const stage of op.stages) {
            if (!this.liveStages_.has(stage.name)) { this.liveStages_.add(stage.name); this.completionDirty_ = true; }
        }
        if (op.thread !== null && !this.liveThreads_.has(op.thread)) {
            this.liveThreads_.add(op.thread); this.completionDirty_ = true;
        }
    }

    private publishUpdate_(job: LoadJob, update: CliTraceUpdate): void {
        if (job !== this.loadJob_ || job.controller.signal.aborted ||
            (!job.published && update.instructions.length === 0)) return;
        if (!job.published) {
            this.liveInstructions_ = [];
            this.ids_ = new Map(); this.gids_ = new Map(); this.rids_ = new Map();
            this.intervals_ = null;
            this.liveStages_ = new Set(); this.liveThreads_ = new Set();
            this.completionDirty_ = true;
            this.resetView_(update);
            this.traceComplete_ = false;
            job.published = true;
        }
        for (const op of update.instructions) this.updateInstruction_(op);
        this.trace_ = { ...update, instructions: this.liveInstructions_ };
        this.state_.range = { ...update.range };
        this.state_.instructionCount = this.liveInstructions_.length;
        this.state_.warningCount = update.warningCount;
    }

    private async loadTrace_(job: LoadJob): Promise<void> {
        const signal = job.controller.signal;
        try {
            const trace = await this.load_(job.state.file, { signal, onProgress: (progress) => {
                if (job === this.loadJob_ && !signal.aborted && Number.isFinite(progress)) {
                    job.state.progress = Math.max(job.state.progress, Math.min(0.95, Math.max(0, progress)));
                }
            }, onUpdate: job.live ? (update) => this.publishUpdate_(job, update) : undefined });
            signal.throwIfAborted();
            if (job !== this.loadJob_) return;
            if (job.published) {
                // 通常は途中通知で全差分を反映済み。EOFで届く一式も照合し、同じobjectは
                // 再索引せず、最後の通知がないloaderにも対応する。調査位置は初期化しない。
                for (let index = 0; index < trace.instructions.length; index++) {
                    this.updateInstruction_(trace.instructions[index]);
                    if ((index + 1) % 8192 === 0) {
                        await new Promise<void>((resolve) => setTimeout(resolve, 0));
                        signal.throwIfAborted();
                    }
                }
                this.publishUpdate_(job, { ...trace, instructions: [] });
                this.traceComplete_ = true;
                job.state.status = "ready";
                job.state.progress = 1;
                return;
            }
            const ids = new Map<number, number>();
            const gids = new Map<number, number[]>();
            const rids = new Map<number, number[]>();
            const stages = new Set<string>();
            const threads = new Set<number>();
            // 索引を作る途中にも入力／cancelへ制御を返す。準備済みの一式だけを公開し、
            // 読込み中のshow／findを部分索引や別ログの命令へ向けない。
            for (let index = 0; index < trace.instructions.length; index++) {
                const op = trace.instructions[index];
                ids.set(op.id, index);
                for (const stage of op.stages) stages.add(stage.name);
                if (op.thread !== null) threads.add(op.thread);
                for (const [map, key] of [[gids, op.gid], [rids, op.status === "retired" ? op.rid : null]] as const) {
                    if (key !== null) {
                        const bucket = map.get(key);
                        if (bucket === undefined) map.set(key, [index]);
                        else bucket.push(index);
                    }
                }
                if ((index + 1) % 8192 === 0) {
                    job.state.progress = Math.max(job.state.progress, 0.95 + 0.04 * (index + 1) / trace.instructions.length);
                    await new Promise<void>((resolve) => setTimeout(resolve, 0));
                    signal.throwIfAborted();
                }
            }
            const intervals = buildIntervals(trace.instructions);
            signal.throwIfAborted();
            if (job !== this.loadJob_) return;
            this.trace_ = trace;
            this.traceComplete_ = true;
            this.intervals_ = intervals;
            this.ids_ = ids; this.gids_ = gids; this.rids_ = rids;
            this.liveInstructions_ = [];
            this.liveStages_.clear(); this.liveThreads_.clear();
            this.completionValues_ = { stages: Object.freeze([...stages].sort()),
                threads: Object.freeze([...threads].sort((a, b) => a - b).map(String)) };
            this.completionDirty_ = false;
            this.resetView_(trace);
            job.state.status = "ready";
            job.state.progress = 1;
        }
        catch (error) {
            if (signal.aborted || job !== this.loadJob_) return;
            job.state.status = "failed";
            job.state.error = { code: "read_error", message: error instanceof Error ? error.message : String(error) };
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

    // 専用構文を順番に読むだけとし、SQL engineや汎用式評価器は導入しない。
    // 同期の一回の走査中は途中通知を挟まず、実行開始時の公開範囲を集計する。
    private aggregate_(args: string[], response: CliResponse): CliCountResult {
        const usage = () => fail("invalid_command", `Invalid arguments. ${commandHelp("count")![0]}`);
        if (args[1] !== "instructions") usage();
        let index = 2;
        let idRange: CliCountResult["scope"]["idRange"] = null;
        if (args[index] === "range") {
            if (args[index + 1] !== "id" || args.length < index + 4) usage();
            const first = integer(args[index + 2]);
            const last = integer(args[index + 3]);
            if (first < 0 || last < first) fail("invalid_number", "Expected nonnegative IDs with FIRST <= LAST.");
            idRange = { first, last };
            index += 4;
        }
        if (args[index] !== "where" || args[index + 1] !== "stage" || args[index + 2] === undefined ||
            args[index + 3] !== "duration" || args[index + 4] !== ">=" || args[index + 5] === undefined) usage();
        const stageName = args[index + 2];
        if (stageName === "") fail("invalid_command", "Stage names cannot be empty.");
        const minimumDuration = integer(args[index + 5]);
        if (minimumDuration < 0) fail("invalid_number", "The minimum duration cannot be negative.");
        index += 6;
        let groupBy: "pc" | null = null;
        let top: number | null = null;
        if (args[index] === "group") {
            if (args[index + 1] !== "by" || args[index + 2] !== "pc") usage();
            groupBy = "pc";
            top = 10;
            index += 3;
            if (args[index] === "top") {
                if (args[index + 1] === undefined) usage();
                top = integer(args[index + 1], true);
                if (top > 256) fail("invalid_number", "top cannot exceed 256 PC groups.");
                index += 2;
            }
        }
        if (index !== args.length) usage();
        const trace = this.requireTrace_();
        const result: CliCountResult = { kind: "count",
            scope: { source: trace.source, idRange, thread: this.state_.filters.thread ?? null, complete: this.traceComplete_ },
            condition: { stage: stageName, minimumDuration }, totalInstructions: 0, matchedInstructions: 0,
            percentage: null, unfinishedInstructions: 0, maximumDuration: null,
            groupBy, groups: [], totalGroups: 0, top };
        const groups = new Map<string | null, CliCountResult["groups"][number]>();
        for (const op of trace.instructions) {
            if (!this.matchesFilter_(op) || (idRange !== null && (op.id < idRange.first || op.id > idRange.last))) continue;
            result.totalInstructions++;
            let maximum: number | null = null;
            let unfinished = false;
            for (const stage of op.stages) {
                if (stage.name !== stageName) continue;
                if (stage.end === null) { unfinished = true; continue; }
                const duration = safe(stage.end - stage.begin);
                if (duration >= minimumDuration) maximum = Math.max(maximum ?? duration, duration);
            }
            if (unfinished) result.unfinishedInstructions++;
            if (maximum === null) continue;
            result.matchedInstructions++;
            result.maximumDuration = Math.max(result.maximumDuration ?? maximum, maximum);
            if (groupBy !== null) {
                const pc = instructionPC(op.label);
                const group = groups.get(pc);
                if (group === undefined) groups.set(pc, { pc, count: 1, maximumDuration: maximum });
                else { group.count++; group.maximumDuration = Math.max(group.maximumDuration, maximum); }
            }
        }
        result.percentage = result.totalInstructions === 0 ? null : result.matchedInstructions / result.totalInstructions * 100;
        result.totalGroups = groups.size;
        // 同件数は正規化したhexの桁数・文字列で数値順にする。不明PCは同件数の最後。
        result.groups = [...groups.values()].sort((a, b) => b.count - a.count ||
            (a.pc === null ? b.pc === null ? 0 : 1 : b.pc === null ? -1 :
                a.pc.length - b.pc.length || (a.pc < b.pc ? -1 : a.pc > b.pc ? 1 : 0))).slice(0, top ?? 0);
        response.truncated = result.groups.length < result.totalGroups;
        return result;
    }

    // 時間窓とは独立した縮小表示。疎なIDの差ではなく実際の命令数で区切り、入力配列は並べ替えない。
    // 全行で原点・縮尺を共有し、中間行が遅く終了しても切れないよう代表命令の最大endを使う。
    private overview_(firstID: number, lastID: number): Extract<CliResult, { kind: "overview" }> {
        const trace = this.requireTrace_();
        const matches = trace.instructions.filter((op) => firstID <= op.id && op.id <= lastID && this.matchesFilter_(op))
            .sort((a, b) => a.id - b.id);
        const groupCount = Math.min(this.state_.rowLimit, matches.length);
        const rows: CliOverviewRow[] = [];
        for (let index = 0; index < groupCount; index++) {
            const begin = Math.floor(index * matches.length / groupCount);
            const end = Math.floor((index + 1) * matches.length / groupCount);
            const op = matches[begin + Math.floor((end - begin) / 2)];
            const counts = { retired: 0, flushed: 0, incomplete: 0 };
            for (let item = begin; item < end; item++) counts[matches[item].status]++;
            rows.push({ firstID: matches[begin].id, lastID: matches[end - 1].id,
                instructionCount: end - begin, ...counts,
                representative: { id: op.id, gid: op.gid, rid: op.rid, thread: op.thread,
                    status: op.status, begin: op.begin, end: op.end,
                    duration: op.end === null ? null : safe(op.end - op.begin) }, cells: [] });
        }
        if (rows.length === 0) return { kind: "overview", rows, totalInstructions: 0, axis: null };
        const observedEnd = (op: CliOverviewRow["representative"]) => op.end ?? Math.max(op.begin, trace.range.end);
        const begin = Math.min(...rows.map((row) => row.representative.begin));
        const end = Math.max(...rows.map((row) => observedEnd(row.representative)));
        const span = safe(end - begin);
        const columns = this.state_.columns;
        for (const row of rows) {
            const op = row.representative;
            // 表示列へのfloor／ceilは整数比で求め、大きいcycleでも境界の丸めで1列ずらさない。
            // span=0は一点だけを表示し、終了時刻やdurationを架空の1cycleへ広げない。
            const scale = BigInt(span || 1);
            const left = BigInt(safe(op.begin - begin)) * BigInt(columns);
            const right = BigInt(safe(observedEnd(op) - begin)) * BigInt(columns);
            const start = Math.min(columns - 1, Number(left / scale));
            const finish = Math.min(columns, Math.max(start + 1, Number((right + scale - 1n) / scale)));
            const marker = op.status === "flushed" ? "x" : op.status === "incomplete" ? "?" : "*";
            row.cells = Array.from({ length: columns }, (_, column) => start <= column && column < finish ? marker : ".");
        }
        return { kind: "overview", rows, totalInstructions: matches.length,
            axis: { begin, end, cyclesPerColumn: span / columns } };
    }

    // 窓と交差する命令を索引で集め、filter・paginationとセル化を両出力方式へ共通適用する。
    // 未終了stageの表示には観測範囲を使うが、記録データのend=nullは変更しない。
    private timeline_(response: CliResponse): Extract<CliResult, { kind: "timeline" }> {
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
                status: op.status, begin: op.begin, end: op.end,
                continuesBefore: op.begin < begin, continuesAfter: op.end === null || op.end > end, cells };
        }) };
    }

    private find_(direction: number, repeat: boolean, response: CliResponse): CliResult {
        const trace = this.requireTrace_();
        const search = this.search_ ?? fail("no_search", "Run find before next or prev.");
        const cursor = this.searchCursorID_ === null ? undefined : this.ids_.get(this.searchCursorID_);
        const key = repeat && cursor !== undefined ? trace.instructions[cursor] :
            { begin: this.state_.window.begin, id: -Infinity };
        // 入力の到着順ではなく、区間木の開始時刻・ID順で検索する。新しい検索は窓の左端、
        // 続きの検索は最後の一致命令から始める。goto／detailによる調査で起点を変えない。
        function* candidates(node: IntervalNode | null): Generator<CliInstruction> {
            if (node === null) return;
            const order = comparePosition(node, key) * direction;
            const eligible = order > 0 || (order === 0 && !repeat && direction > 0);
            if (eligible) yield* candidates(direction > 0 ? node.left : node.right);
            if (eligible) yield trace.instructions[node.index];
            yield* candidates(direction > 0 ? node.right : node.left);
        }
        for (const op of candidates(this.intervals_)) {
            const found = search.kind === "label" ? op.label.includes(search.text) : op.stages.some((stage) =>
                stage.name === search.name && stage.end !== null && stage.end - stage.begin >= search.minimum);
            if (this.matchesFilter_(op) && found) {
                this.searchCursorID_ = op.id;
                this.move_(op.begin);
                return { ...this.timeline_(response), matchID: op.id };
            }
        }
        return fail("not_found", "No matching instruction in this direction; the search does not wrap.");
    }
}
