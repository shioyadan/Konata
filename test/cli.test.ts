/**
 * 小さい既知ログで、共有Parserとの整合、CLIの状態遷移・区間検索・表示契約を検証する。
 * 実際の入口・JSON Lines・stderr・EOF・終了コードはcli_bundle_smoke.jsで検証する。
 * GUI起動や巨大ログの性能測定は対象にせず、通常の単体testから実行できるようにする。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";

import { Zstd } from "@hpcc-js/wasm-zstd";

import { completeCliCommand } from "../src/cli/completion";
import { CLI_COMMAND_NAMES, CliSession, tokenizeCommand, type CliLoadOptions, type CliResponse, type CliTrace } from "../src/cli/session";
import { formatCliText } from "../src/cli/text_output";
import { inspectCliTrace, loadCliTrace } from "../src/cli/trace_loader";
import { FileLineReader } from "../src/core/file_line_reader";
import { Gem5O3PipeViewParser } from "../src/core/gem5_o3_pipe_view_parser";
import type { Stage } from "../src/core/model";
import { OnikiriParser } from "../src/core/onikiri_parser";

const source = [
    "Kanata\t0004", "C=\t100",
    "I\t20\t120\t0", "L\t20\t0\t0x1160 dload4", "S\t20\t0\tIF",
    "C\t1", "S\t20\t0\tID",
    "I\t3\t103\t1", "L\t3\t0\t0x1160 dload4", "S\t3\t0\tIF", "S\t3\taux\tID",
    "C\t3", "S\t20\t0\tEX", "R\t3\t-1\t1",
    "I\t900000000000\t130\t0", "L\t900000000000\t0\tpoint", "S\t900000000000\t0\tRt", "R\t900000000000\t2\t0",
    "C\t2", "I\t4\t103\t0", "L\t4\t0\t0x1160 dload4", "S\t4\t0\tIF",
    "C\t1", "S\t4\t0\tID", "C\t1", "R\t4\t1\t0",
    "C\t96", "R\t20\t0\t0",
    "I\t5\t105\t-1", "L\t5\t0\tunfinished", "L\t5\t1\traw detail", "S\t5\t0\tIF",
].join("\n");

function input(contents: string | Uint8Array, name = "fixture.log") {
    const bytes = typeof contents === "string" ? new TextEncoder().encode(contents) : contents;
    return { name, size: bytes.byteLength, type: "", stream: () => new Blob([bytes as BlobPart]).stream() };
}

async function session(contents = source): Promise<CliSession> {
    const trace = await inspectCliTrace(input(contents));
    const result = new CliSession(async (file) => {
        if (file === "bad.log") throw new Error("Cannot read trace.");
        return trace;
    });
    assert.equal((await result.execute('open --sync "fixture.log"')).ok, true);
    return result;
}

function timeline(response: CliResponse) {
    assert.equal(response.ok, true, response.error?.message);
    assert.equal(response.result?.kind, "timeline");
    if (response.result?.kind !== "timeline") throw new Error("Expected timeline.");
    return response.result;
}

function detail(response: CliResponse) {
    assert.equal(response.ok, true, response.error?.message);
    assert.equal(response.result?.kind, "detail");
    if (response.result?.kind !== "detail") throw new Error("Expected detail.");
    return response.result;
}

function overview(response: CliResponse) {
    assert.equal(response.ok, true, response.error?.message);
    assert.equal(response.result?.kind, "overview");
    if (response.result?.kind !== "overview") throw new Error("Expected overview.");
    return response.result;
}

function match(response: CliResponse): number {
    const id = timeline(response).matchID;
    assert.notEqual(id, undefined, "Search results must identify the matching instruction.");
    return id!;
}

const gem5Source = [
    "1000: system.cpu.rename: [tid:2]: Processing instruction [sn:12]",
    "O3PipeView:fetch:1000:0x12:0:12: store: raw label", "O3PipeView:decode:2000",
    "O3PipeView:complete:3000", "O3PipeView:retire:5000:store:9000",
    "O3PipeView:fetch:1000:0x10:0:10: add", "O3PipeView:thread:1000:1",
    "O3PipeView:decode:2000", "O3PipeView:retire:4000",
    "O3PipeView:fetch:2000:0x11:0:11: flushed", "O3PipeView:decode:3000", "O3PipeView:retire:0",
    "O3PipeView:fetch:6000:0x13:0:13: incomplete", "O3PipeView:decode:7000",
].join("\n");

test("CLI auto-detects gem5, shares GUI identities and keeps raw ticks without counting display widths", async () => {
    const trace = await inspectCliTrace(input(gem5Source));
    const gui = await new Gem5O3PipeViewParser(undefined, () => undefined).parse(new FileLineReader(input(gem5Source)));
    try {
        assert.equal(trace.format, "gem5");
        assert.deepEqual(trace.range, { begin: 0, end: 7 });
        assert.deepEqual(trace.instructions.map((op) => [op.id, op.gid, op.thread, op.status]),
            [[0, 10, 1, "retired"], [2, 12, 2, "retired"], [1, 11, 0, "flushed"], [3, 13, 0, "incomplete"]]);
        for (const op of trace.instructions) {
            const original = gui.getOp(op.id)!;
            assert.equal(op.begin, original.fetchedCycle);
            assert.equal(op.label, original.labelName);
            assert.equal(op.source.line, original.line);
            assert.equal(op.thread, original.tid);
            assert.equal(op.detail, original.labelDetail);
            assert.deepEqual(op.stages.map((stage) => [stage.name, stage.begin]),
                original.lanes.flatMap((lane) => lane?.stages.map((stage) => [stage.name, stage.startCycle]) ?? []));
        }
        assert.deepEqual(trace.instructions[1].stages.map((stage) => [stage.name, stage.begin, stage.end]),
            [["F", 0, 1], ["Dc", 1, 2], ["Cm", 2, 4], ["Rt", 4, 4]]);
        assert.equal(trace.instructions[1].end, 4);
        assert.match(trace.instructions[1].detail, /Retired Tick: 5000\nStore Tick: 9000/);
        assert.deepEqual(trace.instructions[2].stages.map((stage) => [stage.begin, stage.end]), [[1, 2], [2, 2]]);
        assert.equal(trace.instructions[2].end, 2);
        assert.equal(trace.instructions[3].end, null);
        assert.equal(trace.instructions[3].rid, null);
        assert.deepEqual(trace.instructions[3].stages.map((stage) => [stage.begin, stage.end]), [[5, 6], [6, null]]);
        assert.ok(trace.warnings.some((warning) => warning.includes("incomplete")));
        const cli = new CliSession(async () => trace);
        await cli.execute("open --sync fixture.log");
        assert.equal(cli.state.format, "gem5");
        assert.deepEqual(cli.completionValues.threads, ["0", "1", "2"]);
        const point = timeline(await cli.execute("goto cycle 4")).rows.find((op) => op.id === 2)!;
        assert.equal(point.cells[0], "@Rt");
        await cli.execute("goto cycle 0");
        await cli.execute("filter thread 2");
        await cli.execute("find stage Cm min 2");
        assert.equal(detail(await cli.execute("detail gid 12")).instruction.gid, 12);
        assert.deepEqual(detail(await cli.execute("detail gid 12 stage Rt")).stages.map((stage) =>
            [stage.name, stage.begin, stage.end, stage.duration]), [["Rt", 4, 4, 0]]);
    }
    finally { gui.close(); }
});

test("CLI reads compressed gem5 and rejects unsafe ticks, IDs or non-integral cycles without rounding", async () => {
    const plain = await inspectCliTrace(input(gem5Source));
    const compressed = (await Zstd.load()).compress(new TextEncoder().encode(gem5Source));
    for (const [bytes, name] of [[gzipSync(gem5Source), "gem5.gz"], [compressed, "gem5.zst"]] as const) {
        const trace = await inspectCliTrace(input(bytes, name), "fixture.log");
        assert.deepEqual(trace, plain);
    }
    for (const record of [
        "O3PipeView:fetch:9007199254740993:0x10:0:1: bad tick",
        "O3PipeView:fetch:1000:0x10:0:9007199254740993: bad ID",
        "O3PipeView:fetch:0.5:0x10:0:1: fractional tick",
        "O3PipeView:thread:1000:9007199254740993",
        "O3PipeView:retire:1000:store:9007199254740993",
        "1000: system.cpu.rename: [tid:9007199254740993]: Processing instruction [sn:1]",
        "1000: system.cpu.rename: [tid:1]: Processing instruction [sn:9007199254740993]",
    ]) await assert.rejects(() => inspectCliTrace(input(record)), /integer/);
    await assert.rejects(() => inspectCliTrace(input(
        "O3PipeView:fetch:1000:0x10:0:1: fractional cycle\nO3PipeView:decode:2000\nO3PipeView:retire:3500")), /fractional/);
});

test("CLI open defaults to background loading and --sync explicitly waits for completion", async () => {
    const trace = await inspectCliTrace(input(source));
    const requests = new Map<string, (trace: CliTrace) => void>();
    const cli = new CliSession((file) => new Promise<CliTrace>((resolve) => { requests.set(file, resolve); }));
    const opening = await cli.execute("open first.log");
    assert.equal(opening.ok, true);
    assert.equal(opening.state.file, null);
    assert.equal(opening.state.loading!.status, "loading");
    const unavailable = await cli.execute("show");
    assert.equal(unavailable.error?.code, "loading");
    assert.match(formatCliText(unavailable), /Try show again.*wait/);
    requests.get("first.log")!({ ...trace, source: "first.log" });
    assert.equal((await cli.execute("wait")).state.file, "first.log");

    let completed = false;
    const synchronous = cli.execute("open --sync second.log").then((response) => {
        completed = true;
        return response;
    });
    const loading = await cli.execute("status");
    assert.equal(completed, false);
    assert.equal(loading.state.file, "first.log");
    assert.equal(loading.state.loading!.file, "second.log");
    assert.equal(loading.state.loading!.status, "loading");
    requests.get("second.log")!({ ...trace, source: "second.log" });
    const ready = await synchronous;
    assert.equal(ready.ok, true);
    assert.equal(ready.state.file, "second.log");
    assert.equal(ready.state.loading!.status, "ready");
});

test("CLI background loading keeps the current investigation responsive and replaces it only on success", async () => {
    const old = await inspectCliTrace(input(source), "old.log");
    const next = await inspectCliTrace(input(gem5Source), "next.log");
    let options: CliLoadOptions | undefined;
    let complete!: (trace: CliTrace) => void;
    const cli = new CliSession(async (file, loadOptions) => {
        if (file === "old.log") return old;
        options = loadOptions;
        return new Promise<CliTrace>((resolve) => { complete = resolve; });
    });
    await cli.execute("open --sync old.log");
    await cli.execute("filter thread 0");
    await cli.execute("find dload4");
    const opening = await cli.execute("open next.log");
    assert.equal(opening.ok, true);
    assert.equal(opening.state.file, "old.log");
    assert.equal(opening.state.loading?.status, "loading");
    const snapshot = cli.state;
    options!.onProgress!(0.4);
    assert.equal(snapshot.loading!.progress, 0);
    const progress = await cli.execute("status");
    assert.equal(progress.state.loading!.progress, 0.4);
    assert.match(formatCliText(progress), /next.log \| loading \| 40%/);
    assert.equal(timeline(await cli.execute("show")).rows[0].id, 20);
    assert.equal(match(await cli.execute("next")), 4);
    const waiting = cli.execute("wait");
    complete(next);
    assert.equal((await waiting).ok, true);
    assert.equal(cli.state.file, "next.log");
    assert.equal(cli.state.format, "gem5");
    assert.equal(cli.state.loading!.status, "ready");
    assert.equal(cli.state.loading!.progress, 1);
    assert.deepEqual(cli.state.filters, {});
    assert.equal((await cli.execute("next")).error?.code, "no_search");
});

test("CLI cancels and replaces asynchronous loads, ignores stale completion and exposes failure without losing state", async () => {
    const trace = await inspectCliTrace(input(source), "old.log");
    const requests = new Map<string, { options: CliLoadOptions; resolve: (trace: CliTrace) => void;
        reject: (error: Error) => void }>();
    const cli = new CliSession(async (file, options) => {
        if (file === "old.log") return trace;
        return new Promise<CliTrace>((resolve, reject) => { requests.set(file, { options: options!, resolve, reject }); });
    });
    assert.equal((await cli.execute("status")).ok, true);
    assert.equal((await cli.execute("wait")).ok, true);
    await cli.execute("open --sync old.log");
    await cli.execute("goto id 4");
    await cli.execute("filter thread 0");
    const view = () => { const { loading: _loading, ...state } = cli.state; return state; };
    const saved = view();
    await cli.execute("open first");
    const obsoleteWait = cli.execute("wait");
    await cli.execute("open second");
    assert.equal(requests.get("first")!.options.signal!.aborted, true);
    requests.get("first")!.options.onProgress!(0.9);
    assert.equal(cli.state.loading!.progress, 0);
    requests.get("first")!.resolve({ ...trace, source: "stale.log" });
    assert.equal((await obsoleteWait).error?.code, "load_canceled");
    assert.equal(cli.state.loading!.file, "second");
    assert.deepEqual(view(), saved);
    const canceledWait = cli.execute("wait");
    assert.equal((await cli.execute("cancel")).ok, true);
    assert.equal(cli.state.loading!.status, "canceled");
    assert.equal(requests.get("second")!.options.signal!.aborted, true);
    requests.get("second")!.resolve({ ...trace, source: "canceled.log" });
    assert.equal((await canceledWait).error?.code, "load_canceled");
    assert.deepEqual(view(), saved);
    await cli.execute("open failure");
    requests.get("failure")!.reject(new Error("Cannot read background trace."));
    const failure = await cli.execute("wait");
    assert.equal(failure.error?.code, "read_error");
    assert.equal(failure.state.loading!.status, "failed");
    assert.match(formatCliText(await cli.execute("status")), /failed.*Cannot read background trace/);
    assert.deepEqual(view(), saved);
    assert.equal(timeline(await cli.execute("show")).rows[0].id, 20);
    await cli.execute("open --async quit-load");
    await cli.execute("quit");
    assert.equal(requests.get("quit-load")!.options.signal!.aborted, true);
    requests.get("quit-load")!.resolve(trace);
    await cli.finishLoading();
    assert.deepEqual(view(), saved);
});

test("CLI loading aborts the input stream and yields progress before publishing a complete trace", async () => {
    const controller = new AbortController();
    let cancelCount = 0;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const pendingInput = { name: "pending.log", size: 1024, type: "", stream: () => new ReadableStream<Uint8Array>({
        start(stream) { stream.enqueue(new TextEncoder().encode("Kanata\t0004\nI\t0\t0\t0\n")); markStarted(); },
        cancel() { cancelCount++; },
    }) };
    const loading = inspectCliTrace(pendingInput, pendingInput.name, { signal: controller.signal });
    await started;
    controller.abort();
    await assert.rejects(loading, /canceled|abort/i);
    assert.equal(cancelCount, 1);
    const progress: number[] = [];
    const large = source + "\n" + "C\t0\n".repeat(8192);
    const trace = await inspectCliTrace(input(large), "fixture.log", { onProgress: (value) => progress.push(value) });
    assert.equal(trace.instructions.length, 5);
    assert.ok(progress.length >= 2);
    assert.ok(progress.every((value) => value >= 0 && value < 1));
});

test("CLI cancel stays responsive during indexing and does not publish partial indices", async () => {
    const trace = await inspectCliTrace(input(source), "old.log");
    const large = { ...trace, source: "large.log", instructions: Array.from({ length: 16384 }, (_, id) =>
        ({ ...trace.instructions[0], id })) };
    const cli = new CliSession(async (file) => file === "old.log" ? trace : large);
    await cli.execute("open --sync old.log");
    const started = await cli.execute("open large.log");
    assert.equal(started.state.loading!.status, "loading");
    assert.ok(cli.state.loading!.progress >= 0.95);
    assert.equal(started.state.instructionCount, trace.instructions.length);
    assert.equal(timeline(await cli.execute("show")).rows.length, 4);
    await cli.execute("cancel");
    await cli.finishLoading();
    assert.equal(cli.state.file, "old.log");
    assert.equal(cli.state.loading!.status, "canceled");
});

test("CLI inspects a held Kanata stream before EOF and preserves the view as late instructions arrive", async () => {
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    let notify!: () => void;
    const available = new Promise<void>((resolve) => { notify = resolve; });
    const held = { name: "live.log", size: 4096, type: "", stream: () => new ReadableStream<Uint8Array>({
        start(controller) { stream = controller; },
    }) };
    let updates = 0;
    const cli = new CliSession((_file, options) => inspectCliTrace(held, held.name, { ...options,
        onUpdate(update) {
            options?.onUpdate?.(update);
            updates += update.instructions.length;
            if (cli.state.instructionCount === 1) notify();
        },
    }));
    await cli.execute("open live.log");
    stream.enqueue(new TextEncoder().encode([
        "Kanata\t0004", "C=\t100", "I\t0\t100\t0", "S\t0\t0\tID",
        "I\t1\t101\t1", "L\t1\t0\tneedle", "S\t1\t0\tIF", "C\t3", "R\t1\t0\t0", "",
    ].join("\n")));
    await available;
    const first = await cli.execute("show");
    assert.equal(first.state.loading!.status, "loading");
    assert.deepEqual(timeline(first).rows.map((op) => op.id), [1]);
    assert.match(formatCliText(first), /loading.*showing available instructions/);
    await cli.execute("filter thread 1");
    await cli.execute("find needle");
    await cli.execute("zoom 2");
    await cli.execute("show 1");
    const window = cli.state.window;
    const original = detail(await cli.execute("detail 1"));
    // 先に生成された長い命令と、retire後に更新される既存命令を同じchunkで通知する。
    stream.enqueue(new TextEncoder().encode("L\t1\t0\t updated\nC\t100\nR\t0\t1\t0\nI\t2\t102\t1\nL\t2\t0\tneedle tail\nS\t2\t0\tID\n"));
    stream.close();
    assert.equal((await cli.execute("wait")).ok, true);
    assert.equal(cli.state.loading!.status, "ready");
    assert.equal(cli.state.instructionCount, 3);
    assert.equal(updates, 4); // 既存命令1の更新も差分に含むが、重複登録しない。
    assert.deepEqual(cli.state.filters, { thread: 1 });
    assert.deepEqual(cli.state.window, window);
    assert.equal(cli.state.cyclesPerColumn, 2);
    assert.equal(cli.state.rowOffset, 1);
    assert.equal(original.instruction.label, "needle");
    assert.equal(detail(await cli.execute("detail 1")).instruction.label, "needle updated");
    assert.equal(match(await cli.execute("next")), 2);
    const unfinished = detail(await cli.execute("detail 2"));
    assert.equal(unfinished.instruction.end, null);
    assert.equal(unfinished.stages[0].end, null);
    await cli.execute("filter clear");
    assert.equal(timeline(await cli.execute("goto cycle 150")).rows[0].id, 0);
    assert.equal((await cli.execute("goto rid 1")).state.window.begin, 100);
});

test("CLI live interval and ID indices match a complete trace under unordered additions and replacements", async () => {
    const base = await inspectCliTrace(input(source));
    const ops = Array.from({ length: 1000 }, (_, id) => {
        const begin = (id * 37) % 101;
        const end = id % 29 === 0 ? null : begin + id % 39;
        return { ...base.instructions[0], id, gid: id + 1000, rid: id, begin, end,
            label: `needle ${id}`, status: end === null ? "incomplete" as const : "retired" as const,
            stages: [{ lane: "0", name: "ID", label: "", begin, end }] };
    });
    const trace = { ...base, source: "live.log", instructions: ops, range: { begin: 0, end: 150 } };
    let options!: CliLoadOptions;
    let complete!: (trace: CliTrace) => void;
    const live = new CliSession((_path, value) => {
        options = value!;
        return new Promise<CliTrace>((resolve) => { complete = resolve; });
    });
    await live.execute("open live.log");
    for (let offset = 0; offset < ops.length; offset += 19) {
        options.onUpdate!({ ...trace, instructions: ops.slice(offset, offset + 19).reverse() });
    }
    // 既存nodeの削除・再挿入とgid/rid索引の置換を通す。新しい開始時刻にも移せる。
    for (let id = 0; id < ops.length; id += 3) {
        const begin = (id * 13) % 113;
        ops[id] = { ...ops[id], gid: id + 2000, rid: id + 2000, begin, end: begin + 9,
            status: "retired", stages: [{ lane: "aux", name: "EX", label: "", begin, end: begin + 9 }] };
        options.onUpdate!({ ...trace, instructions: [ops[id]] });
    }
    const sorted = { ...trace, instructions: [...ops].sort((a, b) => a.begin - b.begin || a.id - b.id) };
    const reference = new CliSession(async () => sorted);
    await reference.execute("open --sync fixture.log");
    for (const command of ["goto cycle 0", "show 24", "goto cycle 35", "show 72", "goto cycle 110",
        "goto id 333", "goto gid 2333", "goto rid 2333", "find needle", "next", "next", "prev",
        "filter thread 0", "find stage EX min 9", "next", "prev"]) {
        const actual = await live.execute(command);
        const expected = await reference.execute(command);
        assert.deepEqual(actual.result, expected.result, command);
        assert.deepEqual(actual.error, expected.error, command);
        assert.equal(actual.nextRow, expected.nextRow, command);
    }
    assert.deepEqual(live.completionValues, reference.completionValues);
    assert.equal((await live.execute("goto gid 1333")).error?.code, "not_found");
    complete(sorted);
    await live.execute("wait");
    assert.equal(live.state.instructionCount, ops.length);
});

test("CLI retains published instructions after cancel or read failure and ignores obsolete live updates", async () => {
    const trace = await inspectCliTrace(input(source));
    const requests = new Map<string, { options: CliLoadOptions; resolve: (trace: CliTrace) => void;
        reject: (error: Error) => void }>();
    const cli = new CliSession((file, options) => new Promise<CliTrace>((resolve, reject) => {
        requests.set(file, { options: options!, resolve, reject });
    }));
    await cli.execute("open first");
    const first = requests.get("first")!;
    first.options.onUpdate!({ ...trace, source: "first", instructions: trace.instructions.slice(0, 2) });
    const snapshot = cli.execute("show");
    first.options.onUpdate!({ ...trace, source: "first", instructions: [trace.instructions[2]] });
    const shown = await snapshot;
    assert.equal(shown.state.instructionCount, 2);
    assert.equal(timeline(shown).rows.length, 2);
    assert.equal(cli.state.instructionCount, 3);
    await cli.execute("goto id 20");
    await cli.execute("cancel");
    first.options.onUpdate!({ ...trace, instructions: trace.instructions });
    first.resolve(trace);
    await cli.finishLoading();
    assert.equal(cli.state.file, "first");
    assert.equal(cli.state.instructionCount, 3);
    assert.equal(cli.state.window.begin, 100);
    assert.equal(timeline(await cli.execute("show")).rows.length, 3);
    await cli.execute("open second");
    const second = requests.get("second")!;
    second.options.onUpdate!({ ...trace, source: "second", instructions: trace.instructions.slice(2, 4) });
    await cli.execute("goto id 4");
    second.reject(new Error("Broken remainder."));
    assert.equal((await cli.execute("wait")).error?.code, "read_error");
    assert.equal(cli.state.file, "second");
    assert.equal(cli.state.window.begin, 106);
    assert.equal(cli.state.instructionCount, 2);
    first.options.onUpdate!({ ...trace, instructions: trace.instructions });
    assert.equal(cli.state.file, "second");
    assert.equal(detail(await cli.execute("detail 4")).instruction.id, 4);
});

test("CLI publishes gzip and Zstandard chunks before EOF and keeps final records identical", { timeout: 10000 }, async () => {
    const prefix = "Kanata\t0004\nC=\t100\nI\t0\t10\t0\nL\t0\t0\tneedle\nS\t0\t0\tID\nC\t3\nR\t0\t0\t0\n";
    const suffix = "C\t10\nI\t1\t11\t0\nS\t1\t0\tIF\n";
    const zstd = await Zstd.load();
    for (const [name, compress] of [
        ["live.gz", (text: string) => gzipSync(text)],
        ["live.zst", (text: string) => zstd.compress(new TextEncoder().encode(text))],
    ] as const) {
        const first = compress(prefix), last = compress(suffix);
        let stream!: ReadableStreamDefaultController<Uint8Array>;
        let published!: () => void;
        const available = new Promise<void>((resolve) => { published = resolve; });
        const collected = new Map<number, CliTrace["instructions"][number]>();
        const held = { name, size: first.byteLength + last.byteLength, type: "", stream: () =>
            new ReadableStream<Uint8Array>({ start(controller) { stream = controller; } }) };
        const loading = inspectCliTrace(held, name, { onUpdate(update) {
            for (const op of update.instructions) collected.set(op.id, op);
            if (collected.has(0)) published();
        } });
        // 1 frameを渡した後も入力を閉じない。展開器のEOFとは独立に通知されることを確認する。
        stream.enqueue(first);
        await available;
        assert.equal(collected.get(0)!.end, 103);
        assert.equal(collected.size, 1);
        stream.enqueue(last);
        stream.close();
        const result = await loading;
        const expected = await inspectCliTrace(input(prefix + suffix), name);
        assert.deepEqual(result.instructions, expected.instructions);
        assert.deepEqual(result.range, expected.range);
        assert.equal(result.instructions[1].end, null);
    }
});

test("CLI publishes gem5 reordered instructions before EOF without exposing buffered ticks", { timeout: 10000 }, async () => {
    const prefix = Array.from({ length: 17050 }, (_, id) => {
        const tick = (id + 1) * 1000;
        return `O3PipeView:fetch:${tick}:0x10:0:${id + 10}: needle\nO3PipeView:decode:${tick + 1000}\nO3PipeView:retire:${tick + 2000}\n`;
    }).join("");
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    let published!: () => void;
    const available = new Promise<void>((resolve) => { published = resolve; });
    const held = { name: "gem5-live.log", size: prefix.length + 100, type: "", stream: () =>
        new ReadableStream<Uint8Array>({ start(controller) {
            // Kanata検出の失敗後も、実ファイルと同じく先頭から再読込みできる。
            stream = controller;
            controller.enqueue(new TextEncoder().encode(prefix));
        } }) };
    const cli = new CliSession((_file, options) => inspectCliTrace(held, held.name, { ...options,
        onUpdate(update) {
            options?.onUpdate?.(update);
            if (cli.state.instructionCount > 0) published();
        },
    }));
    await cli.execute("open gem5-live.log");
    await available;
    const first = await cli.execute("show");
    assert.equal(first.state.format, "gem5");
    assert.equal(first.state.loading!.status, "loading");
    assert.ok(first.state.instructionCount > 0 && first.state.instructionCount < 17050);
    assert.equal(timeline(first).rows[0].gid, 10);
    const id = match(await cli.execute("find stage Dc min 1"));
    const inspected = detail(await cli.execute(`detail id ${id}`));
    assert.equal(inspected.instruction.begin, 0);
    assert.equal(inspected.instruction.end, 2);
    assert.equal(inspected.stages.at(-1)!.duration, 0);
    stream.enqueue(new TextEncoder().encode("O3PipeView:fetch:17052000:0x11:0:17060: unfinished\nO3PipeView:decode:17053000\n"));
    stream.close();
    assert.equal((await cli.execute("wait")).ok, true);
    assert.equal(cli.state.instructionCount, 17051);
    assert.equal(cli.state.window.begin, 0);
    assert.equal(match(await cli.execute("next")), 1);
    await cli.execute("goto gid 17060");
    assert.equal(detail(await cli.execute("detail gid 17060")).instruction.end, null);
});

test("CLI live conversion failures reject loading cleanly and retain the previously published data", { timeout: 5000 }, async () => {
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    let published!: () => void;
    const available = new Promise<void>((resolve) => { published = resolve; });
    const held = { name: "broken.log", size: 1024, type: "", stream: () =>
        new ReadableStream<Uint8Array>({ start(controller) { stream = controller; } }) };
    const cli = new CliSession((_file, options) => inspectCliTrace(held, held.name, { ...options,
        onUpdate(update) { options?.onUpdate?.(update); if (cli.state.instructionCount > 0) published(); },
    }));
    await cli.execute("open broken.log");
    stream.enqueue(new TextEncoder().encode("Kanata\t0004\nI\t0\t0\t0\nS\t0\t0\tID\nC\t1\nR\t0\t0\t0\n"));
    await available;
    // 正常な1命令の後に時刻が逆転する命令を与え、非同期の通知callbackからも失敗を回収する。
    stream.enqueue(new TextEncoder().encode("I\t1\t1\t0\nS\t1\t0\tID\nC=\t0\nR\t1\t1\t0\n"));
    const failed = await cli.execute("wait");
    assert.equal(failed.error?.code, "read_error");
    assert.match(failed.error!.message, /Reversed/);
    assert.equal(failed.state.loading!.status, "failed");
    assert.equal(failed.state.instructionCount, 1);
    assert.equal(timeline(await cli.execute("show")).rows[0].id, 0);
});

test("CLI shares Kanata stages and labels while retaining absolute cycles, sparse IDs and unknown ends", async () => {
    const trace = await inspectCliTrace(input(source));
    assert.deepEqual(trace.range, { begin: 100, end: 205 });
    assert.deepEqual(trace.instructions.map((op) => op.id), [20, 3, 900000000000, 4, 5]);
    assert.equal(trace.instructions[1].status, "flushed");
    assert.deepEqual(trace.instructions[1].stages.map((stage) => stage.lane), ["0", "aux"]);
    const unfinished = trace.instructions[4];
    assert.equal(unfinished.end, null);
    assert.equal(unfinished.stages[0].end, null);
    assert.equal(unfinished.thread, null);
    assert.equal(unfinished.detail, "raw detail");
    assert.equal(unfinished.source.line, 29);

    // GUIは従来の相対cycle表示を維持し、CLIの絶対cycleと境界・ラベルを比較する。
    const gui = await new OnikiriParser().parse(new FileLineReader(input(source)));
    for (const op of trace.instructions) {
        const original = gui.getOp(op.id)!;
        assert.equal(original.labelName, op.label);
        assert.equal(original.fetchedCycle + 100, op.begin);
        if (op.end !== null) assert.equal(original.retiredCycle + 100, op.end);
        const stages = original.lanes.flatMap((lane) => lane?.stages ?? []);
        op.stages.forEach((stage, index) => {
            assert.equal(stages[index].name, stage.name);
            assert.equal(stages[index].startCycle + 100, stage.begin);
            if (stage.end !== null) assert.equal(stages[index].endCycle + 100, stage.end);
        });
    }
    gui.close();
});

test("CLI input normalization preserves absolute cycle changes, source lines and a single stream read", async () => {
    const fixture = input([
        "Kanata\t0004", "C=\t42", "I\t0\t0\t0", "S\t0\taux\tIF", "C\t3", "E\t0\taux\tIF",
        "C=\t50", "S\t0\taux\tEX", "C\t2", "R\t0\t0\t0",
    ].join("\n"));
    let streams = 0;
    const trace = await inspectCliTrace({ ...fixture, stream: () => { streams++; return fixture.stream(); } });
    assert.equal(streams, 1);
    assert.equal(trace.instructions[0].source.line, 3);
    assert.deepEqual(trace.range, { begin: 42, end: 53 });
    assert.deepEqual(trace.instructions[0].stages.map((stage) => [stage.begin, stage.end]), [[42, 45], [50, 52]]);
    // stage／lane名は数字に見えても自由文字列であり、IDの検査対象にしない。
    const named = await inspectCliTrace(input("Kanata\t0004\nI\t0\t0\t0\nS\t0\t9007199254740993\t0.5"));
    assert.equal(named.instructions[0].stages[0].lane, "9007199254740993");
    assert.equal(named.instructions[0].stages[0].name, "0.5");
});

test("Parser optional closure tracking leaves default GUI timing and permissive integers unchanged", async () => {
    const fixture = input("Kanata\t0004\nC=\t100\nI\t0\t0\t0\nS\t0\t0\tID\nE\t0\t0\tID\nC\t2\nR\t0\t0\t0");
    const gui = await new OnikiriParser().parse(new FileLineReader(fixture));
    const closed = new WeakSet<Stage>();
    const tracked = await new OnikiriParser(undefined, closed).parse(new FileLineReader(fixture));
    try {
        const guiStage = gui.getOp(0)!.lanes[0]!.stages[0];
        const trackedStage = tracked.getOp(0)!.lanes[0]!.stages[0];
        assert.equal(gui.getOp(0)!.fetchedCycle, 0);
        assert.equal(guiStage.endCycle, 2);
        assert.equal(trackedStage.endCycle, 0);
        assert.equal(closed.has(trackedStage), true);
    }
    finally { gui.close(); tracked.close(); }
    const permissive = await new OnikiriParser().parse(new FileLineReader(input("Kanata\t0004\nC\t0.5\nI\t0\t1e1\t0\nR\t0\t0\t0")));
    try {
        assert.equal(permissive.getOp(0)!.fetchedCycle, 0.5);
        assert.equal(permissive.getOp(0)!.gid, 10);
    }
    finally { permissive.close(); }
});

test("CLI window queries retain long lifetimes, terminal events and parallel lanes", async () => {
    const cli = await session();
    assert.deepEqual(timeline(await cli.execute("show")).rows.map((op) => op.id), [20, 3, 900000000000, 4]);
    const middle = timeline(await cli.execute("goto cycle 150"));
    assert.deepEqual(middle.rows.map((op) => op.id), [20]);
    assert.ok(middle.rows[0].cells.every((cell) => cell === "EX"));
    assert.equal(middle.rows[0].continuesBefore, true);
    assert.equal(middle.rows[0].continuesAfter, true);
    assert.ok(!timeline(await cli.execute("goto cycle 105")).rows.some((op) => op.id === 900000000000));
    const point = timeline(await cli.execute("goto cycle 104")).rows.find((op) => op.id === 900000000000)!;
    assert.equal(point.cells[0], "@Rt");
    const parallel = timeline(await cli.execute("goto cycle 101")).rows.find((op) => op.id === 3)!;
    assert.equal(parallel.cells[0], "*");
    const scaled = timeline(await cli.execute("zoom 4"));
    assert.equal(scaled.rows.find((op) => op.id === 20)!.cells[0], "*");
});

test("CLI overview follows file-local IDs and filters without changing navigation or the search cursor", async () => {
    const cli = await session();
    assert.equal(match(await cli.execute('find "dload4"')), 20);
    await cli.execute("zoom 4");
    await cli.execute("show 2");
    const before = cli.state;
    const response = await cli.execute("overview");
    const result = overview(response);
    assert.deepEqual(result.rows.map((row) => row.representative.id), [3, 4, 5, 20, 900000000000]);
    assert.equal(result.totalInstructions, 5);
    assert.deepEqual(result.axis, { begin: 100, end: 205, cyclesPerColumn: 105 / 32 });
    assert.deepEqual(cli.state, before);
    assert.equal(response.truncated, false);
    assert.equal(response.nextRow, null);
    assert.equal(match(await cli.execute("next")), 3);
    const text = formatCliText(response);
    assert.match(text, /lifetimes are samples, not averages or maxima/);
    assert.match(text, /ID 20 t0 retired 100 -> 204 \(104\)/);
    assert.match(text, /ID 5 t\? incomplete 204 -> unknown \(unknown\)/);

    await cli.execute("filter thread 0");
    assert.deepEqual(overview(await cli.execute("overview 3 20")).rows.map((row) => row.representative.id), [4, 20]);
    assert.equal(overview(await cli.execute("overview 20 20")).rows[0].representative.id, 20);
    assert.deepEqual(overview(await cli.execute("overview 21 100")),
        { kind: "overview", rows: [], totalInstructions: 0, axis: null });
    const filtered = cli.state;
    for (const command of ["overview 20 3", "overview 1.5 10", "overview 0 9007199254740993"]) {
        assert.equal((await cli.execute(command)).error?.code, "invalid_number");
        assert.deepEqual(cli.state, filtered);
    }
});

test("CLI overview groups actual sparse instructions into bounded equal-count ID samples", async () => {
    const base = await inspectCliTrace(input(source));
    const instructions = Array.from({ length: 73 }, (_, index) => ({ ...base.instructions[0],
        id: index * 1000, begin: index * 2, end: index % 3 === 2 ? null : index * 2 + 8, thread: index % 2,
        status: (["retired", "flushed", "incomplete"] as const)[index % 3] }));
    const trace = { ...base, instructions: [...instructions].reverse(), range: { begin: 0, end: 152 } };
    const cli = new CliSession(async () => trace);
    await cli.execute("open --sync samples.log");
    const result = overview(await cli.execute("overview"));
    assert.equal(result.rows.length, 24);
    assert.equal(result.totalInstructions, 73);
    result.rows.forEach((row, index) => {
        const begin = Math.floor(index * 73 / 24);
        const end = Math.floor((index + 1) * 73 / 24);
        assert.equal(row.firstID, instructions[begin].id);
        assert.equal(row.lastID, instructions[end - 1].id);
        assert.equal(row.representative.id, instructions[begin + Math.floor((end - begin) / 2)].id);
        assert.equal(row.instructionCount, end - begin);
        for (const status of ["retired", "flushed", "incomplete"] as const) {
            assert.equal(row[status], instructions.slice(begin, end).filter((op) => op.status === status).length);
        }
        assert.equal(row.cells.length, 32);
    });
    assert.equal(result.rows.reduce((sum, row) => sum + row.instructionCount, 0), 73);
    assert.deepEqual(trace.instructions, [...instructions].reverse());
    await cli.execute("filter thread 0");
    const filtered = overview(await cli.execute("overview"));
    assert.equal(filtered.totalInstructions, 37);
    assert.ok(filtered.rows.every((row) => row.representative.thread === 0));
});

test("CLI overview preserves fetch offsets and late middle-row ends without wrapping and shows points", async () => {
    const base = await inspectCliTrace(input(source));
    const times = [[100, 104], [108, 164], [116, 120], [164, 164]];
    const trace = { ...base, range: { begin: 100, end: 164 },
        instructions: times.map(([begin, end], id) => ({ ...base.instructions[0], id, begin, end,
            status: id === 1 ? "flushed" as const : "retired" as const })) };
    const cli = new CliSession(async () => trace);
    await cli.execute("open --sync bars.log");
    const result = overview(await cli.execute("overview"));
    assert.deepEqual(result.axis, { begin: 100, end: 164, cyclesPerColumn: 2 });
    assert.deepEqual(result.rows.map((row) => row.cells.join("")), [
        "**" + ".".repeat(30), ".".repeat(4) + "x".repeat(28),
        ".".repeat(8) + "**" + ".".repeat(22), ".".repeat(31) + "*",
    ]);
    assert.deepEqual(result.rows.map((row) => row.representative.duration), [4, 56, 4, 0]);
    // 最後の行の終了だけでは、中間命令の寿命を切ってしまう。
    const subset = overview(await cli.execute("overview 0 2"));
    assert.equal(subset.axis!.end, 164);
    assert.equal(subset.rows[1].cells.at(-1), "x");
    const unordered = new CliSession(async () => ({ ...trace,
        instructions: [trace.instructions[2], trace.instructions[0], trace.instructions[1]]
            .map((op, id) => ({ ...op, id })) }));
    await unordered.execute("open --sync unordered.log");
    const shifted = overview(await unordered.execute("overview"));
    assert.equal(shifted.axis!.begin, 100);
    assert.equal(shifted.rows[0].cells.slice(0, 8).join(""), ".".repeat(8));
    assert.equal(shifted.rows[1].cells[0], "*");
});

test("CLI overview keeps incomplete ends unknown, handles zero-span axes and uses gem5 recorded cycles", async () => {
    const cli = await session("Kanata\t0004\nC=\t100\nI\t0\t0\t0\nS\t0\t0\tID\nC\t4");
    const result = overview(await cli.execute("overview"));
    assert.deepEqual(result.axis, { begin: 100, end: 105, cyclesPerColumn: 5 / 32 });
    assert.equal(result.rows[0].cells.join(""), "?".repeat(32));
    assert.equal(result.rows[0].representative.end, null);
    assert.equal(result.rows[0].representative.duration, null);
    const point = await session("Kanata\t0004\nC=\t100\nI\t0\t0\t0\nS\t0\t0\tRt\nR\t0\t0\t0");
    const zero = overview(await point.execute("overview"));
    assert.deepEqual(zero.axis, { begin: 100, end: 100, cyclesPerColumn: 0 });
    assert.equal(zero.rows[0].cells.join(""), "*" + ".".repeat(31));
    assert.equal(zero.rows[0].representative.duration, 0);
    const empty = await session("Kanata\t0004\nC=\t100");
    assert.equal(overview(await empty.execute("overview")).axis, null);
    const gem5 = await session(gem5Source);
    const samples = overview(await gem5.execute("overview"));
    assert.deepEqual(samples.rows.map((row) => [row.representative.id, row.representative.end]),
        [[0, 3], [1, 2], [2, 4], [3, null]]);
    assert.equal(samples.axis!.end, 7);
});

test("CLI overview maps large cycle coordinates exactly and rejects unsafe axis spans atomically", async () => {
    const base = await inspectCliTrace(input(source));
    const maximum = Number.MAX_SAFE_INTEGER;
    const trace = { ...base, range: { begin: maximum - 64, end: maximum },
        instructions: [[maximum - 64, maximum - 63], [maximum - 2, maximum], [maximum, maximum]]
            .map(([begin, end], id) => ({ ...base.instructions[0], id, begin, end })) };
    const cli = new CliSession(async () => trace);
    await cli.execute("open --sync large.log");
    const result = overview(await cli.execute("overview"));
    assert.equal(result.axis!.cyclesPerColumn, 2);
    assert.deepEqual(result.rows.map((row) => row.cells.join("")),
        ["*" + ".".repeat(31), ".".repeat(31) + "*", ".".repeat(31) + "*"]);
    const middle = Math.floor(maximum / 2);
    const long = new CliSession(async () => ({ ...base, range: { begin: 0, end: maximum },
        instructions: [[0, 0], [middle, middle + 1], [maximum, maximum]]
            .map(([begin, end], id) => ({ ...base.instructions[0], id, begin, end })) }));
    await long.execute("open --sync long.log");
    assert.equal(overview(await long.execute("overview")).rows[1].cells.join(""),
        ".".repeat(15) + "**" + ".".repeat(15));
    const wide = new CliSession(async () => ({ ...base, range: { begin: -maximum, end: maximum },
        instructions: [-maximum, maximum].map((begin, id) => ({ ...base.instructions[0], id, begin, end: begin })) }));
    await wide.execute("open --sync wide.log");
    const before = wide.state;
    assert.equal((await wide.execute("overview")).error?.code, "overflow");
    assert.deepEqual(wide.state, before);
});

test("CLI overview updates partial samples during loading and keeps earlier responses immutable", async () => {
    const base = await inspectCliTrace(input(source));
    let options!: CliLoadOptions;
    let complete!: (trace: CliTrace) => void;
    const cli = new CliSession((_file, loadOptions) => {
        options = loadOptions!;
        return new Promise((resolve) => { complete = resolve; });
    });
    await cli.execute("open live.log");
    const partial = { ...base, instructions: [{ ...base.instructions[0], id: 0, end: null, status: "incomplete" as const }],
        range: { begin: 100, end: 120 } };
    options.onUpdate!(partial);
    const response = await cli.execute("overview");
    const first = overview(response);
    assert.equal(first.axis!.end, 120);
    assert.equal(first.rows[0].representative.end, null);
    assert.match(formatCliText(response), /Load: loading.*showing available instructions/);
    const final = { ...partial, range: { begin: 100, end: 132 }, instructions: [
        { ...partial.instructions[0], end: 132, status: "retired" as const },
        { ...base.instructions[0], id: 1, begin: 130, end: 131 },
    ] };
    options.onUpdate!(final);
    assert.equal(overview(await cli.execute("overview")).axis!.end, 132);
    assert.equal(first.axis!.end, 120);
    assert.equal(first.rows[0].representative.end, null);
    complete(final);
    await cli.execute("wait");
    assert.equal(overview(await cli.execute("overview")).totalInstructions, 2);
});

test("CLI preserves zero-cycle closure and stage reentry without inventing unfinished durations", async () => {
    const cli = await session([
        "Kanata\t0004", "I\t0\t10\t0", "S\t0\t0\tID", "E\t0\t0\tID", "C\t2", "R\t0\t0\t0",
        "I\t1\t11\t0", "S\t1\t0\tID", "C\t1", "S\t1\t0\tEX", "C\t1", "S\t1\t0\tID",
    ].join("\n"));
    const zero = detail(await cli.execute("detail 0"));
    assert.equal(zero.stages[0].end, 0);
    assert.equal(zero.stages[0].duration, 0);
    assert.equal(timeline(await cli.execute("show")).rows.find((op) => op.id === 0)!.cells[0], "@ID");
    const reentered = detail(await cli.execute("detail 1"));
    assert.deepEqual(reentered.stages.map((stage) => [stage.name, stage.duration]), [["ID", 1], ["EX", 1], ["ID", null]]);
    await cli.execute("goto cycle 4");
    const tail = timeline(await cli.execute("show")).rows[0];
    assert.equal(tail.cells[0], "ID");
    assert.equal(tail.cells[1], "?");
    assert.equal(timeline(await cli.execute("goto cycle 5")).rows.length, 0);
});

test("CLI stage details filter one explicit instruction without merging reentries, parallel lanes or unknown ends", async () => {
    const cli = await session([
        "Kanata\t0004", "I\t0\t10\t0", "S\t0\t0\tID", "E\t0\t0\tID", "C\t2", "R\t0\t0\t0",
        "I\t1\t11\t0", "S\t1\t0\tID", "S\t1\taux\tID", "C\t1", "S\t1\t0\tEX",
        "E\t1\taux\tID", "C\t1", "S\t1\t0\tID",
    ].join("\n"));
    await cli.execute("goto cycle 20");
    const before = cli.state;
    const response = await cli.execute("detail id 1 stage ID");
    const inspected = detail(response);
    assert.equal(inspected.instruction.id, 1);
    assert.equal(inspected.stageFilter, "ID");
    assert.equal(inspected.totalStages, 3);
    assert.equal(inspected.nextStageOffset, null);
    assert.equal(response.truncated, false);
    assert.deepEqual(inspected.stages.map((stage) => [stage.lane, stage.begin, stage.end, stage.duration]),
        [["0", 2, 3, 1], ["0", 4, null, null], ["aux", 2, 3, 1]]);
    assert.deepEqual(detail(await cli.execute("detail gid 11 stage ID")), inspected);
    assert.equal(detail(await cli.execute("detail rid 0 stage ID")).stages[0].duration, 0);
    assert.equal(detail(await cli.execute("detail 1 stage EX")).stages[0].duration, 1);
    const absent = await cli.execute("detail 1 stage id");
    assert.deepEqual(detail(absent).stages, []);
    assert.equal(detail(absent).totalStages, 0);
    assert.equal(detail(absent).stageFilter, "id");
    assert.match(formatCliText(absent), /No matching stages\./);
    assert.match(formatCliText(response), /lane 0 \| ID \| 4 -> unknown \| duration unknown/);
    assert.equal(detail(await cli.execute("detail 1")).stageFilter, null);
    assert.equal(detail(await cli.execute("detail 1")).stages.length, 4);
    assert.deepEqual(cli.state, before);
});

test("CLI details require explicit IDs and preserve the window across namespaces and hidden instructions", async () => {
    const cli = await session();
    await cli.execute("goto cycle 150");
    assert.equal(detail(await cli.execute("detail gid 120")).instruction.id, 20);
    assert.equal(cli.state.window.begin, 150);
    assert.equal(detail(await cli.execute("detail rid 1")).instruction.id, 4);
    assert.equal(detail(await cli.execute("detail 900000000000")).instruction.id, 900000000000);
    const before = cli.state;
    assert.equal((await cli.execute("detail gid 103")).error?.code, "ambiguous_id");
    assert.deepEqual(cli.state, before);
    await cli.execute("goto cycle 100");
    assert.deepEqual(timeline(await cli.execute("filter thread 1")).rows.map((op) => op.id), [3]);
    const hidden = await cli.execute("goto id 20");
    assert.equal(hidden.state.filters.thread, 1);
    assert.ok(hidden.warnings.some((warning) => warning.includes("hidden")));
    const saved = cli.state;
    const inspected = await cli.execute("detail id 20");
    assert.equal(detail(inspected).instruction.id, 20);
    assert.ok(inspected.warnings.some((warning) => warning.includes("hidden")));
    const stage = await cli.execute("detail id 20 stage EX");
    assert.deepEqual(detail(stage).stages.map((interval) => interval.name), ["EX"]);
    assert.ok(stage.warnings.some((warning) => warning.includes("hidden")));
    assert.deepEqual(cli.state, saved);
    assert.equal((await cli.execute("detail")).error?.code, "invalid_command");
    assert.deepEqual(timeline(await cli.execute("filter clear")).rows.map((op) => op.id), [20, 3, 900000000000, 4]);
});

test("CLI includes a terminal zero-duration stage at the lifetime boundary without extending the lifetime", async () => {
    const cli = await session("Kanata\t0004\nI\t0\t0\t0\nS\t0\t0\tIF\nC\t2\nS\t0\t0\tRt\nR\t0\t0\t0");
    const event = timeline(await cli.execute("goto cycle 2")).rows[0];
    assert.equal(event.cells[0], "@Rt");
    assert.equal(event.end, 2);
    assert.equal(timeline(await cli.execute("goto cycle 3")).rows.length, 0);
    // [begin, end)の右端にある点eventは次の窓まで表示しない。
    assert.equal(timeline(await cli.execute("goto cycle -30")).rows.length, 1);
    assert.ok(!timeline(await cli.execute("show")).rows[0].cells.includes("@Rt"));
});

test("CLI label and stage searches respect filters, use stable ordering and do not wrap", async () => {
    const cli = await session();
    const first = await cli.execute('find "dload4"');
    assert.equal(match(first), 20);
    assert.match(formatCliText(first), /^Match: ID 20/);
    assert.equal(match(await cli.execute("next")), 3);
    assert.equal(match(await cli.execute("next")), 4);
    const last = cli.state;
    assert.equal((await cli.execute("next")).error?.code, "not_found");
    assert.deepEqual(cli.state, last);
    assert.equal(match(await cli.execute("prev")), 3);
    await cli.execute("goto cycle 100");
    assert.equal(match(await cli.execute("find stage ID min 3")), 20);
    assert.equal(match(await cli.execute("next")), 3);
    assert.equal((await cli.execute("next")).ok, false);
    await cli.execute("filter thread 0");
    await cli.execute("goto cycle 100");
    assert.equal(match(await cli.execute("find stage EX min 80")), 20);
    const saved = cli.state;
    await cli.execute('find "absent"');
    assert.deepEqual(cli.state, saved);
    assert.equal((await cli.execute("next")).error?.code, "not_found");
});

test("CLI search cursors are independent of explicit details, navigation and command failures", async () => {
    const cli = await session();
    assert.equal(match(await cli.execute("find dload4")), 20);
    for (const command of ["detail 4", "detail gid 130", "detail rid 1", "detail id 20 stage EX",
        "detail 3 stage IF", "detail rid 1 stage absent"]) {
        const before = cli.state;
        assert.equal((await cli.execute(command)).ok, true);
        assert.deepEqual(cli.state, before);
    }
    await cli.execute("goto id 4");
    await cli.execute("pan 40");
    await cli.execute("show 1");
    assert.equal(match(await cli.execute("next")), 3);
    await cli.execute("goto rid 0");
    await cli.execute("zoom 2");
    assert.equal(match(await cli.execute("next")), 4);
    const saved = cli.state;
    for (const command of ["detail", "detail id 999", "detail id 20 -1", "detail id 20 0.5",
        "detail id 20 stage EX -1", "detail 20 stage EX 0.5", 'detail 20 stage ""',
        "detail 9007199254740993", "find absent"]) {
        assert.equal((await cli.execute(command)).ok, false, command);
        assert.deepEqual(cli.state, saved, command);
    }
    assert.equal(match(await cli.execute("prev")), 3);
    await cli.execute("filter thread 0");
    assert.equal(match(await cli.execute("next")), 4);
    await cli.execute("open --sync fixture.log");
    assert.equal((await cli.execute("next")).error?.code, "no_search");
});

test("CLI command failures are atomic and a successful open resets filters and search", async () => {
    const cli = await session();
    await cli.execute("filter thread 0");
    await cli.execute('find "dload4"');
    const saved = cli.state;
    for (const command of ['open --sync "bad.log"', "filter pc 0x1160", "goto id 999", "zoom 0", "zoom 9007199254740991",
        "goto cycle 9007199254740991", "pan 9007199254740993", 'find "unterminated', "status extra", "unknown"]) {
        assert.equal((await cli.execute(command)).ok, false, command);
        assert.deepEqual(cli.state, saved, command);
    }
    await cli.execute('open --sync "fixture.log"');
    assert.deepEqual(cli.state.filters, {});
    assert.equal((await cli.execute("next")).error?.code, "no_search");
});

test("CLI paginates timelines and full stage details without changing instruction identity", async () => {
    const lines = ["Kanata\t0004"];
    for (let id = 34; id >= 0; id--) lines.push(`I\t${id}\t${id}\t0`, `S\t${id}\t0\tIF`);
    lines.push("C\t1");
    for (let id = 0; id < 35; id++) lines.push(`R\t${id}\t${id}\t0`);
    const cli = await session(lines.join("\n"));
    const first = await cli.execute("show");
    assert.equal(timeline(first).rows.length, 24);
    assert.equal(first.truncated, true);
    assert.equal(first.nextRow, 24);
    const rest = await cli.execute("show 24");
    assert.deepEqual(timeline(rest).rows.map((op) => op.id), Array.from({ length: 11 }, (_, index) => index + 24));
    assert.equal(rest.truncated, false);
    await cli.execute("rows -10");
    assert.equal(cli.state.rowOffset, 14);

    const stages = ["Kanata\t0004", "I\t0\t0\t0"];
    for (let index = 0; index < 260; index++) stages.push("S\t0\t0\tID", "C\t1");
    stages.push("R\t0\t0\t0");
    const many = await session(stages.join("\n"));
    const before = many.state;
    const page = await many.execute("detail id 0");
    assert.equal(detail(page).stages.length, 256);
    assert.equal(page.truncated, true);
    assert.equal(detail(page).nextStageOffset, 256);
    assert.match(formatCliText(page), /use detail id 0 256/);
    assert.equal(detail(await many.execute("detail id 0 256")).stages.length, 4);
    assert.equal(detail(await many.execute("detail 0 256")).stages.length, 4);
    assert.equal((await many.execute("detail 256")).error?.code, "not_found");
    assert.deepEqual(many.state, before);
});

test("CLI paginates matching stage intervals and preserves quoted names in continuation commands", async () => {
    const name = 'EX "quoted"\\wait';
    const stages = ["Kanata\t0004", "I\t0\t0\t0"];
    for (let index = 0; index < 260; index++) {
        stages.push(`S\t0\t0\t${name}`, "C\t1", "S\t0\t0\tIF", "C\t1");
    }
    stages.push("R\t0\t0\t0");
    const cli = await session(stages.join("\n"));
    const before = cli.state;
    const page = await cli.execute(`detail id 0 stage ${JSON.stringify(name)}`);
    assert.equal(page.truncated, true);
    assert.equal(detail(page).totalStages, 260);
    assert.equal(detail(page).nextStageOffset, 256);
    assert.deepEqual(detail(page).stages.map((stage) => [stage.name, stage.begin, stage.duration]),
        Array.from({ length: 256 }, (_, index) => [name, index * 2, 1]));
    const command = /; use (detail .+)\.$/m.exec(formatCliText(page))![1];
    assert.deepEqual(tokenizeCommand(command), ["detail", "id", "0", "stage", name, "256"]);
    const rest = await cli.execute(command);
    assert.equal(rest.truncated, false);
    assert.equal(detail(rest).totalStages, 260);
    assert.equal(detail(rest).nextStageOffset, null);
    assert.deepEqual(detail(rest).stages.map((stage) => stage.begin), [512, 514, 516, 518]);
    assert.deepEqual(detail(await cli.execute(`detail 0 stage ${JSON.stringify(name)} 256`)), detail(rest));
    assert.deepEqual(detail(await cli.execute(`detail 0 stage ${JSON.stringify(name)} 260`)).stages, []);
    assert.equal(detail(await cli.execute("detail 0")).totalStages, 520);
    assert.deepEqual(cli.state, before);
});

test("CLI rejects unsafe or fractional trace numbers and cycle overflow before exposing rounded data", async () => {
    for (const command of ["I\t9007199254740993\t0\t0", "I\t0\t9007199254740993\t0", "C\t0.5",
        "C=\t9007199254740993", "C=\t9007199254740991", "I\t-2\t0\t0", "C\t-1",
        "I\t0\t1e1\t0", "I\t0\t0\t0.5", "L\t0\t0.5\tlabel", "R\t0\t9007199254740993\t0",
        "R\t0\t0\t0.5", "W\t0\t9007199254740993\t0", "W\t0\t0\t0.5"]) {
        await assert.rejects(() => inspectCliTrace(input(`Kanata\t0004\n${command}`)), /integer|cycle|Negative/);
    }
    await assert.rejects(() => inspectCliTrace(input("Kanata\t0004\nC=\t9007199254740990\nC\t2")), /overflow/);
});

test("CLI reports partial input warnings and rejects unsupported or insufficient timing data", async () => {
    const partial = await inspectCliTrace(input("Kanata\t0004\nI\t0\t0\t0\nS\t0\t0\tID\nE\t0"));
    assert.equal(partial.warningCount, 1);
    assert.ok(partial.warnings.some((warning) => warning.includes("1 parser warnings")));
    assert.ok(partial.warnings.some((warning) => warning.includes("incomplete")));
    assert.equal(partial.instructions[0].stages[0].end, null);
    await assert.rejects(() => inspectCliTrace(input("O3PipeView:fetch:1000:0x100:0:1:add")), /ticks per clock/);
    await assert.rejects(() => inspectCliTrace(input("unrelated log")), /not a gem5/);
});

test("CLI tokenization handles quoted paths without a shell and text output removes terminal controls", async () => {
    assert.deepEqual(tokenizeCommand('open "path with spaces/trace.log"'), ["open", "path with spaces/trace.log"]);
    assert.deepEqual(tokenizeCommand('open "C:\\logs\\trace.log"'), ["open", "C:\\logs\\trace.log"]);
    assert.deepEqual(tokenizeCommand('find "say \\"hi\\""'), ["find", 'say "hi"']);
    const cli = await session("Kanata\t0004\nI\t0\t0\t0\nL\t0\t0\t\x1b[2Jlabel\nS\t0\t0\tID");
    const response = await cli.execute("show");
    assert.ok(!formatCliText(response).includes("\x1b"));
    assert.ok(JSON.stringify(response).includes("\\u001b"));
});

test("CLI command-specific help works without a trace and invalid arguments report usage without moving", async () => {
    const empty = new CliSession(loadCliTrace);
    for (const command of CLI_COMMAND_NAMES) {
        const response = await empty.execute(`help ${command}`);
        assert.equal(response.ok, true);
        assert.equal(response.result?.kind, "help");
        assert.match(formatCliText(response), new RegExp(`^Usage: ${command}(?:\\s|$)`));
    }
    assert.match(formatCliText(await empty.execute("help find")), /find stage NAME min N/);
    assert.match(formatCliText(await empty.execute("help detail")), /\[stage NAME\]/);
    assert.equal((await empty.execute("help missing")).error?.code, "invalid_command");
    assert.equal((await empty.execute("help constructor")).ok, false);
    assert.equal((await empty.execute("help find extra")).ok, false);
    assert.equal(empty.state.file, null);

    const cli = await session();
    await cli.execute("goto id 4");
    await cli.execute("filter thread 0");
    const before = cli.state;
    for (const command of ["open", "open --sync", "open --sync --async fixture.log", "open --unknown fixture.log",
        "goto", "goto id", "detail", "detail id", "detail id 20 0 extra", "detail id 20 stage",
        "detail 20 stage", "detail id 20 stage EX 0 extra", "overview 0", "overview 0 10 extra",
        "pan", "rows", "zoom", "filter thread", "find stage ID"]) {
        const response = await cli.execute(command);
        assert.equal(response.ok, false);
        assert.match(response.error!.message, new RegExp(`Usage: ${command.split(" ")[0]} `));
        assert.deepEqual(cli.state, before);
    }
    assert.equal((await cli.execute("help find")).ok, true);
    assert.deepEqual(cli.state, before);
});

test("CLI completion follows argument positions and caches only recorded stage names and thread IDs", async () => {
    const empty = new CliSession(loadCliTrace);
    assert.deepEqual(await completeCliCommand("go", empty.completionValues), [["goto "], "go"]);
    assert.deepEqual(await completeCliCommand("ov", empty.completionValues), [["overview "], "ov"]);
    assert.deepEqual(await completeCliCommand("help ov", empty.completionValues), [["overview "], "ov"]);
    assert.deepEqual((await completeCliCommand("", empty.completionValues))[0],
        [...CLI_COMMAND_NAMES].sort().map((name) => name + " "));
    const cli = await session();
    assert.deepEqual(cli.completionValues, { stages: ["EX", "ID", "IF", "Rt"], threads: ["0", "1"] });
    const before = cli.state;
    const check = async (command: string, candidates: string[], fragment: string) =>
        assert.deepEqual(await completeCliCommand(command, cli.completionValues), [candidates, fragment]);
    await check("goto ", ["cycle ", "gid ", "id ", "rid "], "");
    await check("  goto   cy", ["cycle "], "cy");
    await check("detail r", ["rid "], "r");
    await check("detail ", ["gid ", "id ", "rid "], "");
    await check("detail id ", [], "");
    await check("detail 20 st", ["stage "], "st");
    await check("detail gid 120 ", ["stage "], "");
    await check("detail rid 0 stage E", ["EX "], "E");
    await check("detail 20 stage I", ["ID ", "IF "], "I");
    await check('detail id 20 stage "I', ['"ID" ', '"IF" '], '"I');
    await check("detail id 20 256 ", [], "");
    await check("detail 20 stage EX ", [], "");
    await check("help fi", ["filter ", "find "], "fi");
    await check("filter ", ["clear ", "thread "], "");
    await check("filter thread ", ["0 ", "1 "], "");
    await check("filter clear ", [], "");
    await check("find st", ["stage "], "st");
    await check('find "st', [], '"st');
    await check("find stage I", ["ID ", "IF "], "I");
    await check('find stage "I', ['"ID" ', '"IF" '], '"I');
    await check("find stage ID m", ["min "], "m");
    await check("find stage ID min ", [], "");
    await check("goto id ", [], "");
    await check("unknown ", [], "");
    assert.deepEqual(cli.state, before);
    await cli.execute("filter thread 1");
    assert.deepEqual(cli.completionValues.threads, ["0", "1"]);
    const cached = cli.completionValues;
    assert.equal((await cli.execute('open --sync "bad.log"')).ok, false);
    assert.equal(cli.completionValues, cached);

    const first = await inspectCliTrace(input(source));
    const second = await inspectCliTrace(input("Kanata\t0004\nI\t0\t0\t12\nS\t0\t0\tnew stage"));
    const changing = new CliSession(async (file) => file === "first" ? first : second);
    await changing.execute("open --sync first");
    await changing.execute("open --sync second");
    assert.deepEqual(changing.completionValues, { stages: ["new stage"], threads: ["12"] });
    assert.deepEqual(await completeCliCommand("find stage n", changing.completionValues), [['"new stage" '], "n"]);
    assert.deepEqual(await completeCliCommand("detail 0 stage n", changing.completionValues), [['"new stage" '], "n"]);
    assert.deepEqual(await completeCliCommand("find stage ", { stages: ["safe", "\x1b[2Junsafe"], threads: [] }),
        [["safe "], ""]);
    assert.deepEqual(await completeCliCommand("find stage ", { stages: [""], threads: [] }), [['"" '], ""]);
});

test("CLI path completion preserves relative paths, quotes and directory continuation without using a shell", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "konata-cli-completion-"));
    const values = { stages: [], threads: [] };
    const complete = (line: string) => completeCliCommand(line, values, directory);
    try {
        fs.mkdirSync(path.join(directory, "sub dir"));
        fs.writeFileSync(path.join(directory, "sub dir", "trace.log"), "");
        const names = ["trace.log", "trace with spaces.log", "quote's.log", ".hidden.log"];
        if (process.platform !== "win32") names.push('double"quote.log');
        for (const name of names) {
            fs.writeFileSync(path.join(directory, name), "");
        }
        assert.deepEqual(await complete("open tra"), [['"trace with spaces.log" ', '"trace.log" '], "tra"]);
        assert.deepEqual(await complete("open --as"), [["--async "], "--as"]);
        assert.deepEqual(await complete("open --sy"), [["--sync "], "--sy"]);
        assert.deepEqual(await complete("open --sync tra"), [['"trace with spaces.log" ', '"trace.log" '], "tra"]);
        assert.deepEqual(await complete("open --async tra"), [['"trace with spaces.log" ', '"trace.log" '], "tra"]);
        assert.deepEqual(await complete("open sub"), [['"sub dir' + path.sep], "sub"]);
        const [directories] = await complete("open sub");
        const [files] = await complete("open " + directories[0]);
        assert.equal(files.length, 1);
        assert.deepEqual(tokenizeCommand("open " + files[0]), ["open", path.join("sub dir", "trace.log")]);
        assert.deepEqual(await complete('open "trace with'), [['"trace with spaces.log" '], '"trace with']);
        assert.deepEqual(await complete("open './trace w"), [["'./trace with spaces.log' "], "'./trace w"]);
        for (const [prefix, file] of [["quo", "quote's.log"], ["dou", 'double"quote.log']] as const) {
            if (process.platform === "win32" && file.includes('"')) continue;
            const [candidates] = await complete("open " + prefix);
            assert.deepEqual(tokenizeCommand("open " + candidates[0]), ["open", file]);
        }
        const [singleQuoted] = await complete("open 'quo");
        assert.deepEqual(tokenizeCommand("open " + singleQuoted[0]), ["open", "quote's.log"]);
        assert.deepEqual(await complete("open missing/"), [[], "missing/"]);
        assert.deepEqual(await complete("open trace.log "), [[], ""]);
        const [visible] = await complete("open ");
        assert.ok(visible.every((candidate) => !candidate.includes(".hidden.log")));
        assert.deepEqual(await complete("open .h"), [[".hidden.log "], ".h"]);
        assert.deepEqual(await complete("open .."), [[".." + path.sep], ".."]);
        const absolute = path.join(directory, "trace");
        const [absoluteFiles, fragment] = await complete("open " + absolute);
        assert.equal(fragment, absolute);
        assert.deepEqual(tokenizeCommand("open " + absoluteFiles[0]), ["open", path.join(directory, "trace with spaces.log")]);
        // POSIXで許されるescape／制御文字を含む名前も、補完でshell展開や端末操作を起こさない。
        if (process.platform !== "win32") {
            fs.writeFileSync(path.join(directory, "back\\slash space.log"), "");
            fs.writeFileSync(path.join(directory, "unsafe\x1b.log"), "");
            fs.symlinkSync(path.join(directory, "sub dir"), path.join(directory, "linked"));
            const [backslash] = await complete("open back");
            assert.deepEqual(tokenizeCommand("open " + backslash[0]), ["open", "back\\slash space.log"]);
            assert.deepEqual(await complete("open unsafe"), [[], "unsafe"]);
            assert.deepEqual(await complete("open link"), [["linked/"], "link"]);
        }
    }
    finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
