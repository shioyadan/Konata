"use strict";

// build済みJSとlauncherだけをrepo外へコピーし、tsx・node_modules・HTMLなしで検証する。
// unit testとは別に、配布時の単一file契約と圧縮入力・stdin・終了codeの接続を確認する。
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
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
            const commands = "show\nfind stage ID min 3\ndetail\nstatus\nquit\n";
            const direct = invoke(false, ["--jsonl", file], commands);
            const responses = replies(direct);
            assert.equal(direct.stderr, "");
            assert.equal(responses.length, 6);
            assert.ok(responses.every((reply) => reply.ok && reply.schemaVersion === 1));
            assert.equal(responses[1].result.rows[0].label, "0x1160 dload4");
            assert.equal(responses[3].result.stages[0].duration, 3);
            assert.equal(responses[3].result.stages[1].duration, 2);
            const launched = invoke(true, ["--jsonl", file], commands);
            replies(launched);
            assert.equal(launched.stdout, direct.stdout);
            assert.equal(launched.stderr, "");
        }

        const help = invoke(true, ["--help"], "");
        assert.equal(help.status, 0, help.stderr);
        assert.match(help.stdout, /^Usage: konata\.sh --cli/);
        assert.match(help.stdout, /find stage NAME min N/);
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
        const text = invoke(true, [file], "show\ngoto id 1\ndetail\n");
        assert.equal(text.status, 0, text.stderr);
        assert.match(text.stdout, /Window \[100, 132\)/);
        assert.match(text.stdout, /lane 0 \| ID \| 100 -> 103 \| duration 3/);
        const opened = replies(invoke(true, ["--jsonl"], `open ${JSON.stringify(file)}\nstatus\n`));
        assert.equal(opened.length, 2);
        assert.equal(opened[1].state.file, file);
        const failed = replies(invoke(true, ["--jsonl", file], "goto id 999\nstatus\nquit\nshow\n"), 1);
        assert.equal(failed.length, 4);
        assert.equal(failed[1].ok, false);
        assert.equal(failed[2].state.file, file);
        assert.equal(replies(invoke(true, ["--jsonl", "--unknown"], ""), 1)[0].error.code, "startup_error");
        assert.equal(replies(invoke(true, ["--jsonl", "--", "--help"]), 1)[0].error.code, "read_error");

        const partial = path.join(directory, "partial.log");
        fs.writeFileSync(partial, "Kanata\t0004\nI\t0\t0\t0\nS\t0\t0\tID\nE\t0");
        const warned = invoke(true, ["--jsonl", partial]);
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
