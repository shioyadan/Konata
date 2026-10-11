/**
 * 対話入力のTab補完を担当するNode専用の入出力補助。
 * commandの位置に応じた候補と、openの直下のファイル・directoryを返す。
 * ログの解析・sessionの状態変更は行わず、実行と同じ引用規則で候補をencodeする。
 */
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { CompleterResult } from "node:readline";

import { CLI_COMMAND_NAMES, scanCommandInput, type CliCompletionValues } from "./session";

interface Candidate { value: string; directory?: boolean }

async function fileCandidates(value: string, cwd: string): Promise<Candidate[]> {
    // 入力したrelative／absolute prefixを保ち、探索はそのdirectoryの一階層だけに限定する。
    const separator = Math.max(value.lastIndexOf(path.sep), path.sep === "\\" ? value.lastIndexOf("/") : -1);
    const prefix = value.slice(0, separator + 1);
    const leaf = value.slice(separator + 1);
    const directory = path.resolve(cwd, prefix || ".");
    try {
        const entries = await readdir(directory, { withFileTypes: true });
        const matches = await Promise.all(entries.filter((entry) => entry.name.startsWith(leaf) &&
            (leaf.startsWith(".") || !entry.name.startsWith("."))).map(async (entry) => {
            const isDirectory = entry.isDirectory() || (entry.isSymbolicLink() &&
                await stat(path.join(directory, entry.name)).then((info) => info.isDirectory(), () => false));
            return { value: prefix + entry.name + (isDirectory ? path.sep : ""), directory: isDirectory };
        }));
        if (leaf === "." || leaf === "..") {
            matches.push({ value: prefix + leaf + path.sep, directory: true });
        }
        return matches;
    }
    catch { return []; } // 存在しない／読めないpathへのTabは入力をそのまま残す。
}

export async function completeCliCommand(line: string, values: CliCompletionValues,
    cwd = process.cwd()): Promise<CompleterResult> {
    const { tokens, active } = scanCommandInput(line);
    const fragment = line.slice(active.start);
    const index = tokens.length;
    let words: readonly string[] = [];
    let candidates: Candidate[];
    if (index === 0) words = CLI_COMMAND_NAMES;
    else if (tokens[0] === "help" && index === 1) words = CLI_COMMAND_NAMES;
    else if (tokens[0] === "goto" && index === 1) words = ["cycle", "id", "gid", "rid"];
    else if (tokens[0] === "detail") {
        const stageIndex = ["id", "gid", "rid"].includes(tokens[1]) ? 3 : 2;
        if (index === 1) words = ["id", "gid", "rid"];
        else if (index === stageIndex) words = ["stage"];
        else if (index === stageIndex + 1 && tokens[stageIndex] === "stage") words = values.stages;
    }
    else if (tokens[0] === "filter" && index === 1) words = ["thread", "clear"];
    else if (tokens[0] === "filter" && tokens[1] === "thread" && index === 2) words = values.threads;
    else if (tokens[0] === "find") {
        // quoted textの検索をstage検索へ変えない。stage名自体は自由文字列なので引用できる。
        if (index === 1 && !/^['"]/.test(fragment)) words = ["stage"];
        else if (tokens[1] === "stage" && index === 2) words = values.stages;
        else if (tokens[1] === "stage" && index === 3) words = ["min"];
    }
    if (tokens[0] === "open" && (index === 1 || ((tokens[1] === "--sync" || tokens[1] === "--async") && index === 2))) {
        candidates = index === 1 && active.value.startsWith("--") ?
            ["--sync", "--async"].filter((word) => word.startsWith(active.value)).map((value) => ({ value })) :
            await fileCandidates(active.value, cwd);
    }
    else candidates = words.filter((word) => word.startsWith(active.value)).map((value) => ({ value }));

    // readlineは候補を直接端末へ出すので、ログ名・ファイル名の制御文字を通さない。
    candidates = candidates.filter(({ value }) => !/[\x00-\x1f\x7f-\x9f]/.test(value));
    candidates.sort((a, b) => a.value < b.value ? -1 : a.value > b.value ? 1 : 0);
    // 複数候補の共通prefixが一致するよう、必要なら全候補に同じ引用符を付ける。
    const quote = /^['"]/.test(fragment) ? fragment[0] :
        candidates.some(({ value }) => value === "" || /\s|['"]/.test(value)) ? '"' : "";
    const hits = candidates.map(({ value, directory }) => {
        const encoded = quote === "" ? value : quote + value.replace(/\\/g, "\\\\")
            .split(quote).join("\\" + quote) + (directory ? "" : quote);
        return encoded + (directory ? "" : " ");
    });
    return [hits, fragment];
}
