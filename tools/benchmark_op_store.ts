import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { performance } from "node:perf_hooks";

import type { ParsedTrace } from "../src/core/model";
import { OnikiriParser } from "../src/core/onikiri_parser";
import { ArrayOpStore, type MutableOpStore } from "../src/core/op_store";
import { SerializedPageOpStore } from "../src/core/serialized_page_op_store";

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
    warmLookupMilliseconds: number;
    lookupMilliseconds: number;
    lookupCount: number;
    lookupHits: number;
    progressCallbacks: number;
    parserWarnings: number;
    storeMetricsAfterParse?: StoreMetrics;
    storeMetricsAfterLookup?: StoreMetrics;
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

interface StoreMetrics {
    pageCodec: "json" | "zstd";
    serializedPages: number;
    decodedPages: number;
    serializedCharacters: number;
    storedSize: number;
    opCacheAccesses: number;
    opCacheHits: number;
    levels: readonly {
        span: number;
        serializedPages: number;
        decodedPages: number;
        storedSize: number;
        serializeCount: number;
        serializeMilliseconds: number;
        maxSerializeMilliseconds: number;
        decodeCount: number;
        decodeMilliseconds: number;
        maxDecodeMilliseconds: number;
    }[];
}

interface StoreCase {
    readonly name: string;
    create(): MutableOpStore | Promise<MutableOpStore>;
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

function storeMetrics(store: MutableOpStore): StoreMetrics | undefined {
    if (!(store instanceof SerializedPageOpStore)) {
        return undefined;
    }
    return {
        pageCodec: store.pageCodec,
        serializedPages: store.serializedPageCount,
        decodedPages: store.decodedPageCount,
        serializedCharacters: store.serializedCharacterCount,
        storedSize: store.storedSize,
        opCacheAccesses: store.opCacheAccessCount,
        opCacheHits: store.opCacheHitCount,
        levels: store.levelMetrics.map((level) => ({
            span: level.span,
            serializedPages: level.serializedPages,
            decodedPages: level.decodedPages,
            storedSize: level.storedSize,
            serializeCount: level.serializeCount,
            serializeMilliseconds: Math.round(level.serializeMilliseconds * 100) / 100,
            maxSerializeMilliseconds: Math.round(level.maxSerializeMilliseconds * 100) / 100,
            decodeCount: level.decodeCount,
            decodeMilliseconds: Math.round(level.decodeMilliseconds * 100) / 100,
            maxDecodeMilliseconds: Math.round(level.maxDecodeMilliseconds * 100) / 100,
        })),
    };
}

async function benchmark(name: string, file: File, storeCase: StoreCase): Promise<BenchmarkResult> {
    collectGarbage();
    const before = memorySnapshot();
    let peak = before;
    let progressCallbacks = 0;
    let parserWarnings = 0;
    let trace: ParsedTrace | undefined;
    // zstdのWASM初期化時間は、traceを開いた後のpage処理時間と分けて扱う。
    const store = await storeCase.create();

    // 既知の互換警告は件数だけ記録し、benchmarkのJSON出力を機械処理しやすく保つ。
    const originalWarn = console.warn;
    console.warn = () => {
        parserWarnings++;
    };

    const start = performance.now();
    try {
        trace = await new OnikiriParser(store).parse(file, () => {
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
    const storeMetricsAfterParse = storeMetrics(store);

    // 同一page内の繰り返し取得で、Canvas表示範囲がcacheへ載った後のlatencyを測る。
    const lookupCount = 100000;
    const idSpan = Math.max(1, trace.lastID + 1);
    const warmIDSpan = Math.min(256, idSpan);
    let lookupHits = 0;
    const warmLookupStart = performance.now();
    for (let index = 0; index < lookupCount; index++) {
        if (trace.getOp(index % warmIDSpan) !== undefined) {
            lookupHits++;
        }
    }
    const warmLookupMilliseconds = performance.now() - warmLookupStart;

    // 全IDを順に走査し、page missと復元を含む検索・統計処理側のcostも分離して残す。
    lookupHits = 0;
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
    const storeMetricsAfterLookup = storeMetrics(store);

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
        store: storeCase.name,
        runtime: process.version,
        inputBytes: file.size,
        ...summary,
        parseMilliseconds: Math.round(parseMilliseconds * 100) / 100,
        warmLookupMilliseconds: Math.round(warmLookupMilliseconds * 100) / 100,
        lookupMilliseconds: Math.round(lookupMilliseconds * 100) / 100,
        lookupCount,
        lookupHits,
        progressCallbacks,
        parserWarnings,
        storeMetricsAfterParse,
        storeMetricsAfterLookup,
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
    const stores: StoreCase[] = [
        { name: "ArrayOpStore", create: () => new ArrayOpStore() },
        { name: "HierarchicalJsonOpStore", create: () => new SerializedPageOpStore() },
        { name: "HierarchicalZstdOpStore", create: () => SerializedPageOpStore.createZstd() },
    ];
    const inputs = [
        {
            name: "bundled-gzip",
            create: () => fileFromPath(samplePath, "application/gzip"),
        },
        {
            name: `synthetic-${opCount}`,
            create: () => createSyntheticTrace(opCount),
        },
    ];

    for (const input of inputs) {
        for (const store of stores) {
            // 前の入力Fileを次のbaselineへ持ち越さないよう、組み合わせごとに生成する。
            console.log(JSON.stringify(await benchmark(input.name, input.create(), store)));
        }
    }
}

main().catch((error) => {
    console.error("Op store benchmark failed:", error);
    process.exitCode = 1;
});
