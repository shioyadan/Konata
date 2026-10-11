"use strict";

// build済みJSとlauncherだけをrepo外へコピーし、tsx・node_modules・HTMLなしで検証する。
// unit testとは別に、配布時の単一file契約と圧縮入力・stdin・終了codeの接続を確認する。
const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createInterface } = require("node:readline");
const { gzipSync } = require("node:zlib");

async function run() {
    const root = path.join(__dirname, "..");
    const output = path.join(root, "dist-cli");
    assert.deepEqual(fs.readdirSync(output).sort(), ["konata-cli.js"]);
    const bundle = fs.readFileSync(path.join(output, "konata-cli.js"), "utf8");
    assert.match(bundle, /Konata CLI/);
    assert.match(bundle, /Copyright \(C\) 2016-2026 Ryota Shioya/);
    assert.match(bundle, /Copyright \(c\) 2020 Arjun Barrett/);
    assert.match(bundle, /For Zstandard software/);

    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "konata-cli-bundle-"));
    try {
        const entry = path.join(directory, "konata-cli.js");
        const launcher = path.join(directory, "konata.sh");
        fs.copyFileSync(path.join(output, "konata-cli.js"), entry);
        fs.copyFileSync(path.join(root, "konata.sh"), launcher);
        // Makeから選んだNodeでlauncherも検査し、別versionのsystem Nodeと混在させない。
        const bin = path.join(directory, "bin");
        fs.mkdirSync(bin);
        fs.symlinkSync(process.execPath, path.join(bin, "node"));
        const env = { ...process.env, NODE_PATH: "", NODE_OPTIONS: "", PATH: `${bin}:${process.env.PATH}` };
        const invoke = (viaLauncher, args, input = "quit\n") => spawnSync(
            viaLauncher ? launcher : process.execPath,
            viaLauncher ? ["--cli", ...args] : [entry, ...args],
            { cwd: directory, env, input, encoding: "utf8", timeout: 15000 },
        );
        const replies = (result, status = 0) => {
            assert.equal(result.error, undefined);
            assert.equal(result.signal, null, result.stderr);
            assert.equal(result.status, status, result.stderr);
            return result.stdout.trim().split("\n").map((line) => JSON.parse(line));
        };
        // 実際のNode入力adapterとJSON入口を通しつつ、streamのEOFだけを親から保留する。
        // 対象file以外の読込みは置き換えず、Node 18でも途中cancel／完了を検証できる。
        const verifyLive = async (file) => {
            const child = spawn(process.execPath, ["-e", `
                const fs = require("node:fs");
                const { PassThrough } = require("node:stream");
                const entry = process.argv[1], file = process.argv[2];
                const original = fs.createReadStream;
                fs.createReadStream = (source, ...args) => {
                    if (source !== file) return original(source, ...args);
                    const stream = new PassThrough();
                    stream.write(fs.readFileSync(source));
                    process.once("message", () => { if (!stream.destroyed) stream.end(); });
                    return stream;
                };
                process.once("message", () => process.disconnect());
                process.argv = [process.execPath, entry, "--jsonl", file];
                require(entry);
            `, entry, file], { cwd: directory, env, stdio: ["pipe", "pipe", "pipe", "ipc"] });
            let stderr = "";
            child.stderr.on("data", (chunk) => { stderr += chunk; });
            const output = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
            const next = async () => {
                const line = await output.next();
                assert.equal(line.done, false, stderr);
                return JSON.parse(line.value);
            };
            const command = async (text) => { child.stdin.write(`${text}\n`); return next(); };
            const exit = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
            const deadline = setTimeout(() => child.kill(), 15000);
            try {
                const started = await next();
                assert.equal(started.state.loading.status, "loading");
                let state = started.state;
                while (state.instructionCount === 0) {
                    await new Promise((resolve) => setTimeout(resolve, 10));
                    state = (await command("status")).state;
                }
                const shown = await command("show");
                assert.equal(shown.state.loading.status, "loading");
                assert.equal(shown.result.rows[0].id, 1);
                assert.ok(shown.ok);
                const overview = await command("overview");
                assert.ok(overview.ok);
                assert.equal(overview.result.kind, "overview");
                assert.deepEqual(overview.result.axis, { begin: 100, end: 105, cyclesPerColumn: 5 / 32 });
                assert.equal(overview.result.rows[0].cells.join(""), "*".repeat(32));
                assert.deepEqual(overview.state, shown.state);
                const found = await command("find stage ID min 3");
                assert.ok(found.ok);
                assert.equal(found.result.matchID, 1);
                const detail = await command(`detail id ${found.result.matchID}`);
                assert.equal(detail.result.stages[0].duration, 3);
                const filtered = await command(`detail id ${found.result.matchID} stage EX`);
                assert.equal(filtered.result.stageFilter, "EX");
                assert.deepEqual(filtered.result.stages.map((stage) => [stage.name, stage.duration]), [["EX", 2]]);
                assert.deepEqual(filtered.state, detail.state);
                child.send("eof");
                const ready = await command("wait");
                assert.equal(ready.state.loading.status, "ready");
                assert.equal(ready.state.window.begin, found.state.window.begin);
                assert.equal("selectedID" in ready.state, false);
                assert.equal((await command("next")).error.code, "not_found");
                await command("quit");
                child.stdin.end();
                assert.deepEqual(await exit, { code: 1, signal: null }, stderr);
                assert.equal((await output.next()).done, true); // 自発的な進捗応答を混ぜない。
                assert.equal(stderr, "");
            }
            finally { clearTimeout(deadline); if (child.exitCode === null) child.kill(); }
        };

        // 短いtraceでも行数を増やし、NodeのMessageChannelによる定期yieldも通す。
        const source = Buffer.from([
            "Kanata\t0004", "C=\t100", "I\t1\t101\t0", "L\t1\t0\t0x1160 dload4",
            "S\t1\t0\tID", "C\t3", "S\t1\t0\tEX", "C\t2", "R\t1\t0\t0",
        ].join("\n") + "\n" + "C\t0\n".repeat(8192));
        // fixture生成だけは開発依存を使う。実行するchildにはその依存へのpathを渡さない。
        const { Zstd } = await import("@hpcc-js/wasm-zstd");
        const zstd = await Zstd.load();
        for (const [extension, bytes] of [
            ["log", source], ["log.gz", gzipSync(source)], ["log.zst", zstd.compress(source)],
        ]) {
            const file = path.join(directory, `trace with spaces.${extension}`);
            fs.writeFileSync(file, bytes);
            const commands = "show\nfind stage ID min 3\ndetail id 1\ndetail id 1 stage EX\noverview 1 1\nstatus\nquit\n";
            const direct = invoke(false, ["--jsonl", "--sync", file], commands);
            const responses = replies(direct);
            assert.equal(direct.stderr, "");
            assert.equal(responses.length, 8);
            assert.ok(responses.every((reply) => reply.ok && reply.schemaVersion === 1));
            assert.equal(responses[1].result.rows[0].label, "0x1160 dload4");
            assert.equal(responses[3].result.stages[0].duration, 3);
            assert.equal(responses[3].result.stages[1].duration, 2);
            assert.equal(responses[4].result.stageFilter, "EX");
            assert.deepEqual(responses[4].result.stages.map((stage) => [stage.name, stage.duration]), [["EX", 2]]);
            assert.equal(responses[5].result.kind, "overview");
            assert.equal(responses[5].result.rows[0].representative.duration, 5);
            assert.deepEqual(responses[5].state, responses[4].state);
            const launched = invoke(true, ["--jsonl", "--sync", file], commands);
            replies(launched);
            assert.equal(launched.stdout, direct.stdout);
            assert.equal(launched.stderr, "");
            await verifyLive(file);
        }

        const gem5 = fs.readFileSync(path.join(root, "test/fixtures/gem5-basic.txt"));
        for (const [extension, bytes] of [
            ["log", gem5], ["log.gz", gzipSync(gem5)], ["log.zst", zstd.compress(gem5)],
        ]) {
            const file = path.join(directory, `gem5.${extension}`);
            fs.writeFileSync(file, bytes);
            const commands = "show\ngoto gid 10\ndetail gid 10\ndetail gid 10 stage Rt\noverview\n";
            const direct = invoke(false, ["--jsonl", "--sync", file], commands);
            const responses = replies(direct);
            assert.equal(responses.length, 6);
            assert.ok(responses.every((reply) => reply.ok));
            assert.equal(responses[0].state.format, "gem5");
            assert.equal(responses[3].result.instruction.gid, 10);
            assert.equal(responses[3].result.instruction.end, 6);
            assert.equal(responses[3].result.stages.at(-1).duration, 0);
            assert.deepEqual(responses[4].result.stages.map((stage) => [stage.name, stage.duration]), [["Rt", 0]]);
            assert.equal(responses[5].result.kind, "overview");
            assert.equal(responses[5].result.rows[0].representative.end, 6);
            assert.match(direct.stderr, /Detected ticks per clock: 1000/);
            const launched = invoke(true, ["--jsonl", "--sync", file], commands);
            replies(launched);
            assert.equal(launched.stdout, direct.stdout);
            const background = replies(invoke(true, ["--jsonl"],
                `open ${JSON.stringify(file)}\nstatus\nwait\nshow\n`));
            assert.equal(background.length, 4);
            assert.equal(background[0].state.loading.status, "loading");
            assert.equal(background[2].state.loading.status, "ready");
            assert.equal(background[3].result.rows[0].gid, 10);
            const startup = replies(invoke(true, ["--jsonl", file], "wait\nshow\n"));
            assert.equal(startup.length, 3);
            assert.equal(startup[0].state.loading.status, "loading");
            assert.equal(startup[1].state.loading.status, "ready");
            assert.equal(startup[2].result.rows[0].gid, 10);
        }

        const help = invoke(true, ["--help"], "");
        assert.equal(help.status, 0, help.stderr);
        assert.match(help.stdout, /^Usage: konata\.sh --cli/);
        assert.match(help.stdout, /find stage NAME min N/);
        assert.match(help.stdout, /overview \[first-id last-id\]/);
        assert.doesNotMatch(help.stdout, /\x1b|Konata URL:|konata>/);
        const jsonHelp = replies(invoke(true, ["--jsonl", "--help"], ""));
        assert.equal(jsonHelp.length, 1);
        assert.equal(jsonHelp[0].result.kind, "help");
        const commandHelp = invoke(true, [], "help find\n");
        assert.equal(commandHelp.status, 0, commandHelp.stderr);
        assert.match(commandHelp.stdout, /^Usage: find "text" \| find stage NAME min N/);
        assert.doesNotMatch(commandHelp.stdout, /\x1b|konata>/);
        const commandJsonHelp = replies(invoke(true, ["--jsonl"], "help find\n"));
        assert.equal(commandJsonHelp.length, 1);
        assert.equal(commandJsonHelp[0].result.kind, "help");

        const file = path.join(directory, "trace with spaces.log");
        const text = invoke(true, [file], "wait\nshow\ngoto id 1\ndetail id 1\ndetail id 1 stage EX\noverview\n");
        assert.equal(text.status, 0, text.stderr);
        assert.match(text.stdout, /Window \[100, 132\)/);
        assert.match(text.stdout, /lane 0 \| ID \| 100 -> 103 \| duration 3/);
        assert.match(text.stdout, /Stage filter: EX \| 1 matching interval\n  lane 0 \| EX \| 103 -> 105 \| duration 2/);
        assert.match(text.stdout, /Instruction overview \| 1 matching instructions/);
        assert.match(text.stdout, /\*{32} ID 1 t0 retired 100 -> 105 \(5\)/);
        const opened = replies(invoke(true, ["--jsonl"], `open --sync ${JSON.stringify(file)}\nstatus\n`));
        assert.equal(opened.length, 2);
        assert.equal(opened[1].state.file, file);
        const background = replies(invoke(true, ["--jsonl"],
            `open ${JSON.stringify(file)}\nhelp wait\nwait\nshow\n`));
        assert.equal(background.length, 4);
        assert.equal(background[0].state.loading.status, "loading");
        assert.equal(background[2].state.file, file);
        assert.equal(background[3].result.rows[0].id, 1);
        const canceled = replies(invoke(true, ["--jsonl"],
            `open ${JSON.stringify(file)}\ncancel\nstatus\n`));
        assert.equal(canceled.length, 3);
        assert.equal(canceled[2].state.loading.status, "canceled");
        assert.equal(canceled[2].state.file, null);
        const asyncFailure = replies(invoke(true, ["--jsonl"], 'open "missing.log"\nwait\n'), 1);
        assert.equal(asyncFailure.length, 2);
        assert.equal(asyncFailure[1].state.loading.status, "failed");
        assert.equal(asyncFailure[1].error.code, "read_error");
        const failed = replies(invoke(true, ["--jsonl", "--sync", file], "goto id 999\nstatus\nquit\nshow\n"), 1);
        assert.equal(failed.length, 4);
        assert.equal(failed[1].ok, false);
        assert.equal(failed[2].state.file, file);
        assert.equal(replies(invoke(true, ["--jsonl", "--unknown"], ""), 1)[0].error.code, "startup_error");
        assert.equal(replies(invoke(true, ["--jsonl", "--sync", "--", "--help"]), 1)[0].error.code, "read_error");

        const partial = path.join(directory, "partial.log");
        fs.writeFileSync(partial, "Kanata\t0004\nI\t0\t0\t0\nS\t0\t0\tID\nE\t0");
        const warned = invoke(true, ["--jsonl", "--sync", partial]);
        assert.equal(replies(warned)[0].state.warningCount, 1);
        assert.match(warned.stderr, /Warning at line 4:/);
        assert.equal(fs.existsSync(path.join(directory, "node_modules")), false);
        assert.equal(fs.existsSync(path.join(directory, "index.html")), false);
    }
    finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
    console.log(`Single CLI bundle smoke test passed: konata-cli.js (${Buffer.byteLength(bundle)} bytes)`);
}

void run().catch((error) => { console.error(error); process.exitCode = 1; });
