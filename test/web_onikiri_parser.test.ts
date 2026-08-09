import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { OnikiriParser } from "../src/core/onikiri_parser";
import { ArrayOpStore } from "../src/core/op_store";

function fileFromFixture(relativePath: string, type: string): File {
    const filePath = path.resolve(import.meta.dirname, "..", relativePath);
    const contents = fs.readFileSync(filePath);
    // Bufferの共有領域全体ではなく、このfixtureが占めるbyte範囲だけをFileへ渡す。
    const bytes = new Uint8Array(contents.buffer, contents.byteOffset, contents.byteLength);
    return new File([bytes], path.basename(filePath), { type });
}

test("Web Onikiri parser preserves core commands for a plain-text trace", async () => {
    // I/L/S/E/R/W/Cを組み合わせたfixtureで、browser用のarray storeでも旧Parserと
    // 同じ命令寿命、stage、ラベル、依存関係が復元されることを確認する。
    const file = fileFromFixture("test/fixtures/kanata-basic.txt", "text/plain");
    const trace = await new OnikiriParser().parse(file);

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

    // 文字列の\\nは表示用改行へ戻し、retire後の追加ラベルも警告しつつ保持する。
    assert.equal(producer.labelName, "producer\nname");
    assert.equal(producer.labelDetail, "producer detail; post-retire detail");
    assert.deepEqual(
        producer.lanes.get("0")?.stages.map((stage) => ({
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
    // Wはconsumerのproducer索引とproducerのconsumer索引を同じcycle/typeで作る。
    assert.deepEqual(producer.cons.map((dependency) => ({ ...dependency })), [
        { opID: 1, type: 7, cycle: 3 },
    ]);
    assert.deepEqual(consumer.prods.map((dependency) => ({ ...dependency })), [
        { opID: 0, type: 7, cycle: 3 },
    ]);
    assert.equal(consumer.flush, true);
    assert.equal(consumer.retired, false);
    assert.equal(trace.getOpFromRID(1), undefined);
    assert.equal(trace.getOpFromRID(0), producer);
});

test("Web Onikiri parser streams the bundled gzip sample", async () => {
    // 付属サンプルをDecompressionStream経由で最後まで読み、小fixtureでは拾えない
    // gzip境界、行分割、EOF命令の回帰を旧Parserと共通の代表値で固定する。
    const file = fileFromFixture("docs/kanata-sample-2.log.gz", "application/gzip");
    const progressValues: number[] = [];
    const trace = await new OnikiriParser().parse(file, (progress) => progressValues.push(progress));

    assert.equal(trace.lastID, 4040);
    assert.equal(trace.lastRID, 3625);
    assert.equal(trace.opCount, 4041);
    assert.deepEqual([...trace.laneNames].sort(), ["0", "1"]);
    assert.equal(trace.stageLevelMap.laneNum, 2);
    assert.equal(progressValues.at(-1), 1);

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

test("Web Onikiri parser rejects an ID redefined after retirement", async () => {
    // 完了済みOpをstore境界の背後へ移しても、同じIDのIを新規命令として受理してはならない。
    const contents = [
        "Kanata\t0004",
        "I\t0\t10\t0",
        "R\t0\t0\t0",
        "I\t0\t11\t0",
    ].join("\n");
    const file = new File([contents], "redefined.log", { type: "text/plain" });
    await assert.rejects(
        new OnikiriParser().parse(file),
        /0 is redefined by an I command/,
    );
});

test("Web Onikiri parser does not publish a trace before accepting its header", async () => {
    let updateCount = 0;
    await assert.rejects(
        new OnikiriParser().parse(
            new File(["O3PipeView:fetch:1000"], "gem5.log", { type: "text/plain" }),
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
        new File([lines.join("\n")], "incremental.log", { type: "text/plain" }),
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
        file,
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
