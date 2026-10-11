/**
 * 小さい既知ログで、共有Parserとの整合、CLIの状態遷移・区間検索・表示契約を検証する。
 * 最後の子process testは実際の入口を通し、JSON Lines・stderr・EOF・終了コードも確認する。
 * GUI起動や巨大ログの性能測定は対象にせず、通常の単体testから実行できるようにする。
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";

import { Zstd } from "@hpcc-js/wasm-zstd";

import { completeCliCommand } from "../src/cli/completion";
import { CLI_COMMAND_NAMES, CliSession, tokenizeCommand, type CliResponse, type CliTrace } from "../src/cli/session";
import { formatCliText } from "../src/cli/text_output";
import { inspectCliTrace, loadCliTrace } from "../src/cli/trace_loader";
import { FileLineReader } from "../src/core/file_line_reader";
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
    assert.equal((await result.execute('open "fixture.log"')).ok, true);
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

test("CLI preserves zero-cycle closure and stage reentry without inventing unfinished durations", async () => {
    const cli = await session([
        "Kanata\t0004", "I\t0\t10\t0", "S\t0\t0\tID", "E\t0\t0\tID", "C\t2", "R\t0\t0\t0",
        "I\t1\t11\t0", "S\t1\t0\tID", "C\t1", "S\t1\t0\tEX", "C\t1", "S\t1\t0\tID",
    ].join("\n"));
    await cli.execute("select 0");
    const zero = detail(await cli.execute("detail"));
    assert.equal(zero.stages[0].end, 0);
    assert.equal(zero.stages[0].duration, 0);
    assert.equal(timeline(await cli.execute("show")).rows.find((op) => op.id === 0)!.cells[0], "@ID");
    await cli.execute("select 1");
    const reentered = detail(await cli.execute("detail"));
    assert.deepEqual(reentered.stages.map((stage) => [stage.name, stage.duration]), [["ID", 1], ["EX", 1], ["ID", null]]);
    await cli.execute("goto cycle 4");
    const tail = timeline(await cli.execute("show")).rows[0];
    assert.equal(tail.cells[0], "ID");
    assert.equal(tail.cells[1], "?");
    assert.equal(timeline(await cli.execute("goto cycle 5")).rows.length, 0);
});

test("CLI filters and explicit ID namespaces preserve hidden selection and window position", async () => {
    const cli = await session();
    await cli.execute("goto cycle 150");
    await cli.execute("select gid 120");
    assert.equal(cli.state.window.begin, 150);
    assert.equal(cli.state.selectedID, 20);
    await cli.execute("select rid 1");
    assert.equal(cli.state.selectedID, 4);
    const before = cli.state;
    assert.equal((await cli.execute("select gid 103")).error?.code, "ambiguous_id");
    assert.deepEqual(cli.state, before);
    await cli.execute("goto cycle 100");
    assert.deepEqual(timeline(await cli.execute("filter thread 1")).rows.map((op) => op.id), [3]);
    const hidden = await cli.execute("goto id 20");
    assert.equal(hidden.state.filters.thread, 1);
    assert.ok(hidden.warnings.some((warning) => warning.includes("hidden")));
    assert.equal(detail(await cli.execute("detail")).instruction.id, 20);
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
    await cli.execute('find "dload4"');
    assert.equal(cli.state.selectedID, 20);
    await cli.execute("next");
    assert.equal(cli.state.selectedID, 3);
    await cli.execute("next");
    assert.equal(cli.state.selectedID, 4);
    const last = cli.state;
    assert.equal((await cli.execute("next")).error?.code, "not_found");
    assert.deepEqual(cli.state, last);
    await cli.execute("prev");
    assert.equal(cli.state.selectedID, 3);
    await cli.execute("goto cycle 100");
    await cli.execute("find stage ID min 3");
    assert.equal(cli.state.selectedID, 20);
    await cli.execute("next");
    assert.equal(cli.state.selectedID, 3);
    assert.equal((await cli.execute("next")).ok, false);
    await cli.execute("filter thread 0");
    await cli.execute("goto cycle 100");
    await cli.execute("find stage EX min 80");
    assert.equal(cli.state.selectedID, 20);
    const saved = cli.state;
    await cli.execute('find "absent"');
    assert.deepEqual(cli.state, saved);
    assert.equal((await cli.execute("next")).error?.code, "not_found");
});

test("CLI command failures are atomic and a successful open resets selection, filters and search", async () => {
    const cli = await session();
    await cli.execute("filter thread 0");
    await cli.execute('find "dload4"');
    const saved = cli.state;
    for (const command of ['open "bad.log"', "filter pc 0x1160", "goto id 999", "zoom 0", "zoom 9007199254740991",
        "goto cycle 9007199254740991", "pan 9007199254740993", 'find "unterminated', "status extra", "unknown"]) {
        assert.equal((await cli.execute(command)).ok, false, command);
        assert.deepEqual(cli.state, saved, command);
    }
    await cli.execute('open "fixture.log"');
    assert.equal(cli.state.selectedID, null);
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
    await many.execute("select 0");
    const page = await many.execute("detail");
    assert.equal(detail(page).stages.length, 256);
    assert.equal(page.truncated, true);
    assert.equal(detail(page).nextStageOffset, 256);
    assert.equal(detail(await many.execute("detail 256")).stages.length, 4);
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

test("CLI reuses streaming gzip and Zstandard readers and reports partial input warnings", async () => {
    const compressed = (await Zstd.load()).compress(new TextEncoder().encode(source));
    const plain = await inspectCliTrace(input(source));
    for (const [bytes, name] of [[gzipSync(source), "fixture.gz"], [compressed, "fixture.zst"]] as const) {
        const trace = await inspectCliTrace(input(bytes, name), "fixture.log");
        assert.deepEqual(trace.instructions, plain.instructions);
    }
    const partial = await inspectCliTrace(input("Kanata\t0004\nI\t0\t0\t0\nS\t0\t0\tID\nE\t0"));
    assert.equal(partial.warningCount, 1);
    assert.ok(partial.warnings.some((warning) => warning.includes("1 parser warnings")));
    assert.ok(partial.warnings.some((warning) => warning.includes("incomplete")));
    assert.equal(partial.instructions[0].stages[0].end, null);
    await assert.rejects(() => inspectCliTrace(input("O3PipeView:fetch:1000:0x100:0:1:add")), /not a Kanata/);
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
    assert.equal((await empty.execute("help missing")).error?.code, "invalid_command");
    assert.equal((await empty.execute("help constructor")).ok, false);
    assert.equal((await empty.execute("help find extra")).ok, false);
    assert.equal(empty.state.file, null);

    const cli = await session();
    await cli.execute("goto id 4");
    await cli.execute("filter thread 0");
    const before = cli.state;
    for (const command of ["open", "goto", "goto id", "select", "pan", "rows", "zoom", "filter thread", "find stage ID"]) {
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
    assert.deepEqual((await completeCliCommand("", empty.completionValues))[0],
        [...CLI_COMMAND_NAMES].sort().map((name) => name + " "));
    const cli = await session();
    assert.deepEqual(cli.completionValues, { stages: ["EX", "ID", "IF", "Rt"], threads: ["0", "1"] });
    const before = cli.state;
    const check = async (command: string, candidates: string[], fragment: string) =>
        assert.deepEqual(await completeCliCommand(command, cli.completionValues), [candidates, fragment]);
    await check("goto ", ["cycle ", "gid ", "id ", "rid "], "");
    await check("  goto   cy", ["cycle "], "cy");
    await check("select r", ["rid "], "r");
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
    assert.equal((await cli.execute('open "bad.log"')).ok, false);
    assert.equal(cli.completionValues, cached);

    const first = await inspectCliTrace(input(source));
    const second = await inspectCliTrace(input("Kanata\t0004\nI\t0\t0\t12\nS\t0\t0\tnew stage"));
    const changing = new CliSession(async (file) => file === "first" ? first : second);
    await changing.execute("open first");
    await changing.execute("open second");
    assert.deepEqual(changing.completionValues, { stages: ["new stage"], threads: ["12"] });
    assert.deepEqual(await completeCliCommand("find stage n", changing.completionValues), [['"new stage" '], "n"]);
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

test("CLI JSON Lines returns one clean response per command, stays deterministic and sets batch exit status", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "konata-cli-"));
    const file = path.join(directory, "trace with spaces.log");
    try {
        fs.writeFileSync(file, source);
        const trace: CliTrace = await loadCliTrace(file);
        assert.equal(trace.source, file);
        const entry = path.resolve(import.meta.dirname, "../src/cli/main.ts");
        const commands = `open ${JSON.stringify(file)}\nshow\nfind stage ID min 3\ndetail\nstatus\n`;
        const run = (columns: string, inputText = commands, extras: string[] = []) => spawnSync(process.execPath,
            ["--import", "tsx", entry, "--jsonl", ...extras], {
                input: inputText, encoding: "utf8", timeout: 10000,
                env: { ...process.env, COLUMNS: columns },
            });
        const first = run("40");
        assert.equal(first.status, 0, first.stderr);
        assert.equal(first.stderr, "");
        assert.equal(first.stdout, run("200").stdout);
        const replies = first.stdout.trim().split("\n").map((line) => JSON.parse(line) as CliResponse);
        assert.equal(replies.length, 5);
        assert.ok(replies.every((reply) => reply.ok && reply.schemaVersion === 1));
        const local = new CliSession(loadCliTrace);
        for (const [index, command] of commands.trim().split("\n").entries()) {
            assert.deepEqual(replies[index], await local.execute(command));
        }
        const failure = run("80", `open ${JSON.stringify(file)}\ngoto id 999\nstatus\nquit\nshow\n`);
        assert.equal(failure.status, 1);
        const failedReplies = failure.stdout.trim().split("\n").map((line) => JSON.parse(line) as CliResponse);
        assert.equal(failedReplies.length, 4);
        assert.equal(failedReplies[1].ok, false);
        assert.equal(failedReplies[2].ok, true);
        assert.equal(run("80", "status\n", [file]).stdout.trim().split("\n").length, 2);
        const blank = run("80", "\n");
        assert.equal(blank.status, 1);
        assert.equal(JSON.parse(blank.stdout).ok, false);
        const options = run("80", "", ["--unknown"]);
        assert.equal(options.status, 1);
        assert.equal(JSON.parse(options.stdout).error.code, "startup_error");
        const help = run("80", "help find\n");
        assert.equal(help.status, 0, help.stderr);
        assert.deepEqual(JSON.parse(help.stdout), await new CliSession(loadCliTrace).execute("help find"));
        const positional = run("80", "quit\n", ["--", "--help"]);
        assert.equal(positional.status, 1);
        assert.equal(JSON.parse(positional.stdout.split("\n")[0]).error.code, "read_error");
        const optionLikePath = spawnSync(process.execPath, ["--import", "tsx", entry, "--", "--jsonl"], {
            input: "quit\n", encoding: "utf8", timeout: 10000, env: process.env,
        });
        assert.equal(optionLikePath.status, 1);
        assert.match(optionLikePath.stdout, /^Error \[read_error\]/);
        const partialPath = path.join(directory, "partial.log");
        fs.writeFileSync(partialPath, "Kanata\t0004\nI\t0\t0\t0\nS\t0\t0\tID\nE\t0");
        const partial = run("80", "quit\n", [partialPath]);
        assert.equal(partial.status, 0);
        assert.match(partial.stderr, /Warning at line 4:/);
        const partialReplies = partial.stdout.trim().split("\n").map((line) => JSON.parse(line) as CliResponse);
        assert.equal(partialReplies.length, 2);
        assert.equal(partialReplies[0].state.warningCount, 1);
        assert.ok(partialReplies[0].warnings.some((warning) => warning.includes("1 parser warnings")));
    }
    finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
