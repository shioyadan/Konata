import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { Zstd } from "@hpcc-js/wasm-zstd";

import { FileLineReader } from "../src/core/file_line_reader";
import { OnikiriParser } from "../src/core/onikiri_parser";
import { ArrayOpStore } from "../src/core/op_store";
import {
    KonataZstdCompressionStream,
    KonataZstdDecompressionStream,
    createKonataZstdPageCompressor,
} from "../src/core/zstd_stream";

function fileFromFixture(relativePath: string, type: string): File {
    const filePath = path.resolve(import.meta.dirname, "..", relativePath);
    const contents = fs.readFileSync(filePath);
    // Bufferの共有領域全体ではなく、このfixtureが占めるbyte範囲だけをFileへ渡す。
    const bytes = new Uint8Array(contents.buffer, contents.byteOffset, contents.byteLength);
    return new File([bytes], path.basename(filePath), { type });
}

// 形式Parser単体でも、入力媒体はFileLineReaderの境界で渡す。
function reader(file: File): FileLineReader {
    return new FileLineReader(file);
}

test("Web line reader preserves long UTF-8 lines across bounded decode chunks", async () => {
    // 8 KiB境界の直前から3-byte文字を置き、TextDecoderをまたいでも文字化けしないことを確認する。
    // 同じ行を8 KiBより長くし、内部の分割を改行と誤認せず、CRLFだけを除くことも固定する。
    const longLine = `${"a".repeat(8 * 1024 - 1)}あ`;
    const file = new File([`${longLine}\r\ntail`], "utf8-boundary.log", { type: "text/plain" });
    const lines: string[] = [];
    await new FileLineReader(file).readLines((line) => lines.push(line));

    assert.deepEqual(lines, [longLine, "tail"]);
});

test("Web line reader parses lines synchronously between browser yields", async () => {
    const source = `${Array.from({ length: 8193 }, (_, index) => `line-${index}`).join("\n")}\n`;
    const file = new File([source], "callback.log", { type: "text/plain" });
    Object.defineProperty(file, "stream", { value: () => new ReadableStream<Uint8Array>({
        start(controller) {
            // 全行を同じstream chunkへ入れ、chunk取得によるawaitが行間に混ざらない条件を作る。
            controller.enqueue(new TextEncoder().encode(source));
            controller.close();
        },
    }) });

    let lineCount = 0;
    let browserYielded = false;
    await new FileLineReader(file).readLines((line) => {
        assert.equal(line, `line-${lineCount}`);
        lineCount++;
        if (lineCount === 1) {
            queueMicrotask(() => {
                browserYielded = true;
            });
        }
        if (lineCount === 8192) {
            // 先頭8,192行は1つの同期loopで処理し、行ごとのPromise／microtaskを挟まない。
            assert.equal(browserYielded, false);
        }
        if (lineCount === 8193) {
            // 定期間隔ではMessageChannelへ制御を返し、描画とcancelを処理可能にする。
            assert.equal(browserYielded, true);
        }
    });

    assert.equal(lineCount, 8193);
});

test("Web line reader corrects compressed progress for decompressed data awaiting parsing", async () => {
    const source = `${Array.from({ length: 16385 }, () => "C\t0").join("\n")}\n`;
    const compressed = (await Zstd.load()).compress(new TextEncoder().encode(source));
    const file = new File([compressed], "progress.log.zst");
    const progressValues: number[] = [];
    let lineCount = 0;

    await new FileLineReader(file).readLines(
        () => lineCount++,
        (progress) => progressValues.push(progress),
    );

    assert.equal(lineCount, 16385);
    assert.ok(progressValues.length >= 3);
    // 圧縮入力をすべて展開器へ渡していても、最初の8,192行時点では解析待ちを差し引く。
    assert.ok(progressValues[0] > 0 && progressValues[0] < 0.75);
    assert.ok(progressValues.every((progress, index) => index === 0 || progress >= progressValues[index - 1]));
    assert.equal(progressValues.at(-1), 0.99);
});

test("Konata Zstandard streams use the future browser API shape in both directions", async () => {
    const source = new TextEncoder().encode("first line\n日本語のsecond line\n");
    // 圧縮・展開の双方をpipeThrough可能な同じ形に固定する。将来native実装へ替える際も、
    // 利用側のconstructor名、format指定、stream接続を変更しないことが目的である。
    const restoredStream = new Blob([source]).stream()
        .pipeThrough(new KonataZstdCompressionStream("zstd"))
        .pipeThrough(new KonataZstdDecompressionStream("zstd"));
    const restored = new Uint8Array(await new Response(restoredStream).arrayBuffer());

    assert.deepEqual(restored, source);
});

test("Konata Zstandard page compression always exposes an asynchronous contract", async () => {
    const compressor = await createKonataZstdPageCompressor(1);
    const encoder = new TextEncoder();
    const requests = Array.from({ length: 16 }, (_, index) =>
        compressor.compress(encoder.encode(`operation page ${index}`)));

    // 内部の非同期queueが埋まり同期fallbackへ切り替わっても、利用側には常にPromiseを返す。
    assert.ok(requests.every((request) => request instanceof Promise));
    const zstd = await Zstd.load();
    const decoder = new TextDecoder();
    const restored = (await Promise.all(requests)).map((compressed) =>
        decoder.decode(zstd.decompress(compressed)));
    assert.deepEqual(restored, Array.from({ length: 16 }, (_, index) => `operation page ${index}`));
    compressor.close();
});

test("Web Onikiri parser preserves core commands for a plain-text trace", async () => {
    // I/L/S/E/R/W/Cを組み合わせたfixtureで、browser用のarray storeでも旧Parserと
    // 同じ命令寿命、stage、ラベル、依存関係が復元されることを確認する。
    const file = fileFromFixture("test/fixtures/kanata-basic.txt", "text/plain");
    const trace = await new OnikiriParser().parse(reader(file));

    assert.equal(trace.lastID, 1);
    assert.equal(trace.lastRID, 0);
    assert.equal(trace.lastCycle, 5);
    assert.equal(trace.opCount, 2);
    assert.deepEqual([...trace.laneNames].sort(), ["0", "1"]);
    assert.equal(trace.stageLevelMap.laneNum, 2);
    assert.equal(trace.stageLevelMap.has("0", "X"), true);
    // Custom色の初期化に使うため、各laneのstageをParserでの初出順に列挙できることも固定する。
    assert.deepEqual(trace.stageLevelMap.getStageNames("0"), ["F", "X", "Rt"]);
    // 同一cycle内でstlへ置き換わったゼロ長のFは描画対象にならないため列挙しない。
    assert.deepEqual(trace.stageLevelMap.getStageNames("1"), ["stl"]);

    const producer = trace.getOp(0);
    const consumer = trace.getOp(1);
    assert.ok(producer);
    assert.ok(consumer);
    const mainLaneID = trace.stageLevelMap.getLaneID("0");
    assert.notEqual(mainLaneID, undefined);

    // 文字列の\\nは表示用改行へ戻し、retire後の追加ラベルも警告しつつ保持する。
    assert.equal(producer.labelName, "producer\nname");
    assert.equal(producer.labelDetail, "producer detail; post-retire detail");
    assert.deepEqual(
        producer.lanes[mainLaneID]?.stages.map((stage) => ({
            name: stage.name,
            labels: stage.labels,
            startCycle: stage.startCycle,
            endCycle: stage.endCycle,
        })),
        [
            { name: "F", labels: "", startCycle: 0, endCycle: 1 },
            { name: "X", labels: "execute\nlabel", startCycle: 1, endCycle: 3 },
            { name: "Rt", labels: "", startCycle: 3, endCycle: 4 },
        ],
    );
    // Wは描画に必要なproducer索引だけをconsumerへ同じcycle/typeで作る。
    assert.deepEqual(consumer.prods.map((dependency) => ({ ...dependency })), [
        { opID: 0, type: 7, cycle: 3 },
    ]);
    assert.equal(consumer.flush, true);
    assert.equal(consumer.retired, false);
    assert.equal(trace.getOpFromRID(1), undefined);
    assert.equal(trace.getOpFromRID(0), producer);
});

test("Web Onikiri parser assigns stable IDs to arbitrary lane names", async () => {
    const contents = [
        "Kanata\t0004",
        "I\t0\t10\t0",
        "S\t0\tz\tF",
        "C\t1",
        "E\t0\tz\tF",
        "S\t0\t__proto__\tX",
        "C\t1",
        "E\t0\t__proto__\tX",
        "R\t0\t0\t0",
    ].join("\n");
    const trace = await new OnikiriParser().parse(
        reader(new File([contents], "lane-name.log", { type: "text/plain" })),
    );
    const op = trace.getOp(0);
    assert.ok(op);

    // 保存用IDは初出順で固定し、後から名前順で前に来るlaneが増えても変更しない。
    const zLaneID = trace.stageLevelMap.getLaneID("z");
    const prototypeLaneID = trace.stageLevelMap.getLaneID("__proto__");
    assert.equal(zLaneID, 0);
    assert.equal(prototypeLaneID, 1);
    assert.equal(trace.stageLevelMap.getLanePosition(zLaneID), 1);
    assert.equal(trace.stageLevelMap.getLanePosition(prototypeLaneID), 0);
    assert.deepEqual(trace.laneNames, ["z", "__proto__"]);
    assert.equal(op.lanes[zLaneID]?.stages[0].name, "F");
    assert.equal(op.lanes[prototypeLaneID]?.stages[0].name, "X");
});

test("Web Onikiri parser streams the bundled gzip sample", async () => {
    // 付属サンプルをDecompressionStream経由で最後まで読み、小fixtureでは拾えない
    // gzip境界、行分割、EOF命令の回帰を旧Parserと共通の代表値で固定する。
    const file = fileFromFixture("docs/kanata-sample-2.log.gz", "application/gzip");
    const progressValues: number[] = [];
    const trace = await new OnikiriParser().parse(
        reader(file),
        (progress) => progressValues.push(progress),
    );

    assert.equal(trace.lastID, 4040);
    assert.equal(trace.lastRID, 3625);
    assert.equal(trace.opCount, 4041);
    assert.deepEqual([...trace.laneNames].sort(), ["0", "1"]);
    assert.equal(trace.stageLevelMap.laneNum, 2);
    assert.equal(progressValues.at(-1), 0.99);

    const first = trace.getOp(0);
    const last = trace.getOp(trace.lastID);
    assert.ok(first);
    assert.ok(last);
    // 先頭のID・gid・ラベル対応で、streamのchunk境界による行ずれがないことを確認する。
    assert.deepEqual(
        { id: first.id, gid: first.gid, labelName: first.labelName },
        { id: 0, gid: 4, labelName: "00001000: jal zero, 0x10" },
    );
    // サンプル末尾にはRがないため、終端処理で命令を捨てずeofとして残す。
    assert.equal(last.id, 4040);
    assert.equal(last.eof, true);
});

test("Web Onikiri parser streams concurrent Zstandard traces", async () => {
    const sourcePath = path.resolve(import.meta.dirname, "fixtures", "kanata-basic.txt");
    const source = fs.readFileSync(sourcePath);
    const sourceBytes = new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
    const compressed = (await Zstd.load()).compress(sourceBytes);
    // fixtureを増やさず実際のzstd frameを作り、FileLineReaderの拡張子判定とstream展開を通す。
    // OSがMIME typeを付けない通常のfile pickerでも、.zst拡張子から判定できることを確認する。
    const file = new File([compressed], "kanata-basic.txt.zst");
    const secondFile = new File([compressed], "kanata-basic.txt.zstd", { type: "application/zstd" });
    const progressValues: number[] = [];
    // Node.jsテストではsingletonを安全に直列化する。browserでは各streamを別Workerへ分離し、
    // 同じ呼出し方のまま2ファイルを並行して展開できることをbrowser smokeで確認する。
    const [trace, secondTrace] = await Promise.all([
        new OnikiriParser().parse(reader(file), (progress) => progressValues.push(progress)),
        new OnikiriParser().parse(reader(secondFile)),
    ]);

    assert.equal(trace.lastID, 1);
    assert.equal(trace.lastRID, 0);
    assert.equal(trace.lastCycle, 5);
    assert.equal(trace.opCount, 2);
    assert.deepEqual([...trace.laneNames].sort(), ["0", "1"]);
    assert.equal(trace.getOp(0)?.labelName, "producer\nname");
    assert.equal(progressValues.at(-1), 0.99);
    assert.equal(secondTrace.opCount, 2);
});

test("Web Onikiri parser warns and continues after invalid command lines", async () => {
    // 実traceにある改行されたlabel後半、数値不正、ID再定義を無視し、未来のproducerも
    // 警告だけで保持して、後続の正常命令までパースを継続する。
    const contents = [
        "Kanata\t0004",
        "I\t0\t10\t0",
        "L\t0\t1\tvector detail",
        " = VFMV( p416:0x0 )",
        "C\tinvalid",
        "R\t0\t0\t0",
        "I\t0\t11\t0",
        "I\t1\t12\t0",
        "W\t1\t99\t0",
        "C\t1",
        "R\t1\t1\t0",
    ].join("\n");
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (message) => warnings.push(String(message));
    const trace = await new OnikiriParser().parse(
        reader(new File([contents], "warnings.log", { type: "text/plain" })),
    ).finally(() => {
        console.warn = originalWarn;
    });

    assert.equal(trace.opCount, 2);
    assert.equal(trace.lastCycle, 1);
    assert.equal(trace.getOp(0)?.gid, 10);
    assert.equal(trace.getOp(0)?.labelDetail, "vector detail");
    assert.equal(trace.getOp(1)?.gid, 12);
    assert.deepEqual(trace.getOp(1)?.prods.map((dependency) => dependency.opID), [99]);
    assert.equal(trace.warningCount, 4);
    assert.ok(warnings.some((warning) => warning.includes("Unknown command:  = VFMV")));
    assert.ok(warnings.some((warning) => warning.includes("C contains an invalid number")));
    assert.ok(warnings.some((warning) => warning.includes("0 is redefined")));
    assert.ok(warnings.some((warning) => warning.includes("future producer 99")));
});

test("Web Onikiri parser does not publish a trace before accepting its header", async () => {
    let updateCount = 0;
    await assert.rejects(
        new OnikiriParser().parse(
            reader(new File(["O3PipeView:fetch:1000"], "gem5.log", { type: "text/plain" })),
            undefined,
            () => updateCount++,
        ),
        /not a Kanata trace/,
    );
    // gem5へのfallback前に空のKanata traceが一瞬表示されないことを固定する。
    assert.equal(updateCount, 0);
});

test("Web Onikiri parser publishes one live trace while loading", async () => {
    const lines = [
        "Kanata\t0004",
        "I\t0\t10\t0",
        "S\t0\t0\tF",
        "C\t1",
        "R\t0\t0\t0",
    ];
    // FileLineReaderが途中経過を通知する8,192行まで埋め、EOFより前のstore状態を観測する。
    while (lines.length < 8192) {
        lines.push("C\t0");
    }
    lines.push("I\t1\t11\t0", "S\t1\t0\tF", "C\t1", "R\t1\t1\t0");

    const updates: Array<{ trace: object; opCount: number; lastCycle: number }> = [];
    const trace = await new OnikiriParser().parse(
        reader(new File([lines.join("\n")], "incremental.log", { type: "text/plain" })),
        undefined,
        (partialTrace) => updates.push({
            trace: partialTrace,
            opCount: partialTrace.opCount,
            lastCycle: partialTrace.lastCycle,
        }),
    );

    // header受理時、8,192行時、EOF時のいずれも同じtrace/storeを段階更新する。
    assert.ok(updates.length >= 3);
    assert.ok(updates.every((update) => update.trace === trace));
    assert.equal(updates[0].opCount, 0);
    assert.ok(updates.some((update) => update.opCount === 1 && update.lastCycle === 1));
    assert.equal(updates.at(-1)?.opCount, 2);
    assert.equal(trace.lastCycle, 2);
});

test("Web Onikiri parser cancels its input stream through an AbortSignal", async () => {
    const lines = ["Kanata\t0004", "I\t0\t10\t0", "S\t0\t0\tF"];
    while (lines.length < 8192) {
        lines.push("C\t0");
    }
    const contents = `${lines.join("\n")}\n`;
    const file = new File([contents], "cancel.log", { type: "text/plain" });
    let streamCanceled = false;
    Object.defineProperty(file, "stream", { value: () => new ReadableStream<Uint8Array>({
        start(controller) {
            // 先頭だけを渡してEOFを保留し、Parserが次のchunkを待つ状態を再現する。
            controller.enqueue(new TextEncoder().encode(contents));
        },
        cancel() {
            streamCanceled = true;
        },
    }) });

    let notifyProgress: (() => void) | null = null;
    const progressReached = new Promise<void>((resolve) => {
        notifyProgress = resolve;
    });
    const controller = new AbortController();
    const opStore = new ArrayOpStore();
    const parsing = new OnikiriParser(opStore).parse(
        reader(file),
        () => notifyProgress?.(),
        undefined,
        controller.signal,
    );

    await progressReached;
    controller.abort();
    await assert.rejects(parsing, /File loading was canceled/);
    // cancelは表示更新を無視するだけでなく、Fileのstreamと途中OpStoreまで解放する。
    assert.equal(streamCanceled, true);
    assert.equal(opStore.opCount, 0);
});
