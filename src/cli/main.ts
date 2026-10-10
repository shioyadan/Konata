import process from "node:process";
import { createInterface } from "node:readline";

import { CliSession } from "./session";
import { formatCliText } from "./text_output";
import { loadCliTrace } from "./trace_loader";

const args = process.argv.slice(2);
const separator = args.indexOf("--");
const flags = separator === -1 ? args : args.slice(0, separator);
const json = flags.includes("--jsonl");

async function main(): Promise<void> {
    const session = new CliSession(loadCliTrace);
    const interactive = !json && Boolean(process.stdin.isTTY && process.stdout.isTTY);
    let failed = false;
    const run = async (command: string) => {
        const response = await session.execute(command);
        if (!response.ok) failed = true;
        const output = json ? JSON.stringify(response) : formatCliText(response);
        if (output !== "") process.stdout.write(`${output}\n`);
        return response.result?.kind === "quit";
    };
    if (flags.includes("--help") || flags.includes("-h")) {
        if (!json) process.stdout.write("Usage: make cli CLI_ARGS='[--jsonl] [trace.log]'\n\n");
        await run("help");
        return;
    }
    const paths: string[] = [];
    let positional = false;
    for (const arg of args) {
        if (arg === "--" && !positional) positional = true;
        else if (!positional && arg === "--jsonl") continue;
        else if (!positional && arg.startsWith("-")) throw new Error(`Unknown option: ${arg}`);
        else paths.push(arg);
    }
    if (paths.length > 1) throw new Error("The prototype accepts one trace file at a time.");
    if (paths.length === 1) await run(`open "${paths[0].replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`);
    else if (interactive) process.stdout.write('Konata CLI prototype. Use open "path" or help.\n');

    // EOFで自然に終了し、入力済みcommandも逐次awaitしてsessionの操作順を固定する。
    const input = createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
    try {
        if (interactive) process.stdout.write("konata> ");
        for await (const line of input) {
            if (line.trim() !== "" || json) {
                if (await run(line)) break;
            }
            if (interactive) process.stdout.write("konata> ");
        }
    }
    finally {
        input.close();
    }
    if (failed && !interactive) process.exitCode = 1;
}

process.stdout.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EPIPE") process.exit(0);
    else throw error;
});

void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    if (json) {
        const state = new CliSession(loadCliTrace).state;
        process.stdout.write(`${JSON.stringify({ schemaVersion: 1, command: null, ok: false,
            state, result: null, error: { code: "startup_error", message }, warnings: [], truncated: false, nextRow: null })}\n`);
    }
    else process.stderr.write(`Konata CLI: ${message}\n`);
    process.exitCode = 1;
});
