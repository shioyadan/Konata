import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { performance } from "node:perf_hooks";

import type { ParsedTrace } from "../src/core/model";
import { OnikiriParser } from "../src/core/onikiri_parser";
import { ArrayOpStore } from "../src/core/op_store";

interface MemorySnapshot {
    heapUsed: number;
    rss: number;
}

interface BenchmarkResult {
    benchmark: string;
    store: string;
    runtime: string;
    inputBytes: number;
    opCount: number;
    lastID: number;
    lastRID: number;
    lastCycle: number;
    parseMilliseconds: number;
    lookupMilliseconds: number;
    lookupCount: number;
    lookupHits: number;
    progressCallbacks: number;
    parserWarnings: number;
    memoryMiB: {
        heapBefore: number;
        heapPeakSampled: number;
        heapAfterParse: number;
        heapAfterLookup: number;
        heapRetainedDelta: number;
        heapAfterClose: number;
        rssBefore: number;
        rssPeakSampled: number;
        rssAfterParse: number;
        rssAfterClose: number;
    };
}

const garbageCollector = (globalThis as typeof globalThis & { gc?: () => void }).gc;

function collectGarbage(): void {
    garbageCollector?.();
}

function memorySnapshot(): MemorySnapshot {
    const memory = process.memoryUsage();
    return {
        heapUsed: memory.heapUsed,
        rss: memory.rss,
    };
}

function toMiB(bytes: number): number {
    return Math.round(bytes / 1024 / 1024 * 100) / 100;
}

function fileFromPath(filePath: string, type: string): File {
    const contents = fs.readFileSync(filePath);
    // Bufferのpool全体を保持しないよう、fixtureが使うbyte範囲だけをFileへ渡す。
    const bytes = new Uint8Array(contents.buffer, contents.byteOffset, contents.byteLength);
    return new File([bytes], path.basename(filePath), { type });
}

function createSyntheticTrace(opCount: number): File {
    const lines = ["Kanata\t0004", "C=\t-1"];
    for (let id = 0; id < opCount; id++) {
        // 1命令1cycle、1stageの一定形状にし、実装間で入力内容が変わらないようにする。
        lines.push(
            `I\t${id}\t${id}\t0`,
            `L\t${id}\t0\top ${id}`,
            `S\t${id}\t0\tF`,
            "C\t1",
            `E\t${id}\t0\tF`,
            `R\t${id}\t${id}\t0`,
        );
    }
    return new File([lines.join("\n")], `synthetic-${opCount}.log`, { type: "text/plain" });
}

async function benchmark(name: string, file: File): Promise<BenchmarkResult> {
    collectGarbage();
    const before = memorySnapshot();
    let peak = before;
    let progressCallbacks = 0;
    let parserWarnings = 0;
    let trace: ParsedTrace | undefined;

    // 既知の互換警告は件数だけ記録し、benchmarkのJSON出力を機械処理しやすく保つ。
    const originalWarn = console.warn;
    console.warn = () => {
        parserWarnings++;
    };

    const start = performance.now();
    try {
        trace = await new OnikiriParser(new ArrayOpStore()).parse(file, () => {
            progressCallbacks++;
            const current = memorySnapshot();
            peak = {
                heapUsed: Math.max(peak.heapUsed, current.heapUsed),
                rss: Math.max(peak.rss, current.rss),
            };
        });
    }
    finally {
        console.warn = originalWarn;
    }
    const parseMilliseconds = performance.now() - start;
    if (trace === undefined) {
        throw new Error("The parser did not return a trace.");
    }

    collectGarbage();
    const afterParse = memorySnapshot();
    peak = {
        heapUsed: Math.max(peak.heapUsed, afterParse.heapUsed),
        rss: Math.max(peak.rss, afterParse.rss),
    };

    // 同期getOp()はCanvas描画のhot pathなので、parse/memoryと同じ入力で基準値を残す。
    const lookupCount = 100000;
    const idSpan = Math.max(1, trace.lastID + 1);
    let lookupHits = 0;
    const lookupStart = performance.now();
    for (let index = 0; index < lookupCount; index++) {
        if (trace.getOp(index % idSpan) !== undefined) {
            lookupHits++;
        }
    }
    const lookupMilliseconds = performance.now() - lookupStart;
    const afterLookup = memorySnapshot();
    peak = {
        heapUsed: Math.max(peak.heapUsed, afterLookup.heapUsed),
        rss: Math.max(peak.rss, afterLookup.rss),
    };

    const summary = {
        opCount: trace.opCount,
        lastID: trace.lastID,
        lastRID: trace.lastRID,
        lastCycle: trace.lastCycle,
    };
    trace.close();
    trace = undefined;
    collectGarbage();
    const afterClose = memorySnapshot();

    return {
        benchmark: name,
        store: "ArrayOpStore",
        runtime: process.version,
        inputBytes: file.size,
        ...summary,
        parseMilliseconds: Math.round(parseMilliseconds * 100) / 100,
        lookupMilliseconds: Math.round(lookupMilliseconds * 100) / 100,
        lookupCount,
        lookupHits,
        progressCallbacks,
        parserWarnings,
        memoryMiB: {
            heapBefore: toMiB(before.heapUsed),
            heapPeakSampled: toMiB(peak.heapUsed),
            heapAfterParse: toMiB(afterParse.heapUsed),
            heapAfterLookup: toMiB(afterLookup.heapUsed),
            heapRetainedDelta: toMiB(afterParse.heapUsed - before.heapUsed),
            heapAfterClose: toMiB(afterClose.heapUsed),
            rssBefore: toMiB(before.rss),
            rssPeakSampled: toMiB(peak.rss),
            rssAfterParse: toMiB(afterParse.rss),
            rssAfterClose: toMiB(afterClose.rss),
        },
    };
}

function parseOpCount(args: string[]): number {
    const optionIndex = args.indexOf("--ops");
    const value = optionIndex === -1 ? "100000" : args[optionIndex + 1];
    const opCount = Number(value);
    if (!Number.isSafeInteger(opCount) || opCount <= 0) {
        throw new Error(`--ops must be a positive safe integer, but received: ${String(value)}`);
    }
    return opCount;
}

async function main(): Promise<void> {
    if (garbageCollector === undefined) {
        throw new Error("The benchmark must run with --expose-gc.");
    }
    const opCount = parseOpCount(process.argv.slice(2));
    const samplePath = path.resolve(import.meta.dirname, "..", "docs", "kanata-sample-2.log.gz");
    // 前の入力Fileを次のbaselineへ持ち越さないよう、caseごとに生成して直ちに測る。
    console.log(JSON.stringify(await benchmark(
        "bundled-gzip",
        fileFromPath(samplePath, "application/gzip"),
    )));
    console.log(JSON.stringify(await benchmark(
        `synthetic-${opCount}`,
        createSyntheticTrace(opCount),
    )));
}

main().catch((error) => {
    console.error("Op store benchmark failed:", error);
    process.exitCode = 1;
});
