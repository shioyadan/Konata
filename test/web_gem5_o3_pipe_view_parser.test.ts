import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { Gem5O3PipeViewParser } from "../src/core/gem5_o3_pipe_view_parser";

function fileFromFixture(relativePath: string): File {
    const filePath = path.resolve(import.meta.dirname, "..", relativePath);
    const contents = fs.readFileSync(filePath);
    // Bufferの共有poolではなく、fixture自身のbyte範囲だけをFileへ渡す。
    const bytes = new Uint8Array(contents.buffer, contents.byteOffset, contents.byteLength);
    return new File([bytes], path.basename(filePath), { type: "text/plain" });
}

test("Web gem5 parser preserves ticks and pipeline stages", async () => {
    // 旧Parserと共通のfixtureを使い、seqNumからのID/RID割り当てとtick変換を比較する。
    const trace = await new Gem5O3PipeViewParser().parse(
        fileFromFixture("test/fixtures/gem5-basic.txt"),
    );

    assert.equal(trace.lastID, 0);
    assert.equal(trace.lastRID, 0);
    assert.equal(trace.lastCycle, 6);
    assert.equal(trace.opCount, 1);
    assert.deepEqual([...trace.laneNames], ["0"]);
    // UIはこの列挙からCustom色の追加候補を作るため、変換後のstage順を明示する。
    assert.deepEqual(trace.stageLevelMap.getStageNames("0"), ["F", "Dc", "Rn", "Ds", "Is", "Cm"]);

    const op = trace.getOp(0);
    assert.ok(op);
    // 最小tick差分1000を1 cycleとし、先頭tickをcycle 0へ合わせる現行仕様を固定する。
    assert.deepEqual(
        {
            id: op.id,
            gid: op.gid,
            rid: op.rid,
            retired: op.retired,
            flush: op.flush,
            fetchedCycle: op.fetchedCycle,
            retiredCycle: op.retiredCycle,
            consCycle: op.consCycle,
            prodCycle: op.prodCycle,
        },
        {
            id: 0,
            gid: 10,
            rid: 0,
            retired: true,
            flush: false,
            fetchedCycle: 0,
            retiredCycle: 6,
            consCycle: 5,
            prodCycle: 5,
        },
    );
    assert.equal(op.labelName, "0x00001000:  add r1, r2");
    // 新stageの開始tickで直前stageを閉じ、retireはCmを閉じるだけでRtを追加しない。
    assert.deepEqual(
        op.lanes["0"]?.stages.map((stage) => [stage.name, stage.startCycle, stage.endCycle]),
        [
            ["F", 0, 1],
            ["Dc", 1, 2],
            ["Rn", 2, 3],
            ["Ds", 3, 4],
            ["Is", 4, 5],
            ["Cm", 5, 6],
        ],
    );
});

test("Web gem5 parser rejects input without O3PipeView records", async () => {
    // 上位の形式フォールバックが判別できる英語errorを返し、空のtraceとして受理しない。
    const file = new File(["ordinary log line\n"], "ordinary.log", { type: "text/plain" });
    let updateCount = 0;
    await assert.rejects(
        new Gem5O3PipeViewParser().parse(file, undefined, () => updateCount++),
        /not a gem5 O3PipeView trace/,
    );
    // O3PipeView recordを確認するまでは、fallback対象の空traceを画面へ公開しない。
    assert.equal(updateCount, 0);
});

test("Web gem5 parser publishes one trace only after detecting its format", async () => {
    const partialTraces: object[] = [];
    const trace = await new Gem5O3PipeViewParser().parse(
        fileFromFixture("test/fixtures/gem5-basic.txt"),
        undefined,
        (partialTrace) => partialTraces.push(partialTrace),
    );

    // 最初のO3PipeView recordと最終drainで、同じstoreを持つtraceだけを通知する。
    assert.ok(partialTraces.length >= 2);
    assert.ok(partialTraces.every((partialTrace) => partialTrace === trace));
    assert.equal(trace.opCount, 1);
    assert.equal(trace.lastCycle, 6);
});

test("Web gem5 parser reorders sequence numbers and keeps flushed operations", async () => {
    const lines: string[] = [];
    const addRetired = (seqNum: number) => lines.push(
        `O3PipeView:fetch:1000:0x${seqNum}:0:${seqNum}: op ${seqNum}`,
        "O3PipeView:decode:2000",
        "O3PipeView:retire:3000",
    );
    // gem5は命令単位でも順不同に出力するため、seqNum=12を10より先に置く。
    addRetired(12);
    addRetired(10);
    // tick 0以降のstageとretireは、直前の有効tickでflushされたものとして処理する。
    lines.push(
        "O3PipeView:fetch:1000:0x11:0:11: op 11",
        "O3PipeView:decode:2000",
        "O3PipeView:rename:0",
        "O3PipeView:retire:0",
    );

    const trace = await new Gem5O3PipeViewParser().parse(
        new File([lines.join("\n")], "out-of-order.log", { type: "text/plain" }),
    );

    assert.equal(trace.lastID, 2);
    assert.equal(trace.opCount, 3);
    assert.equal(trace.getOp(0)?.gid, 10);
    assert.equal(trace.getOp(1)?.gid, 11);
    assert.equal(trace.getOp(1)?.flush, true);
    assert.equal(trace.getOp(1)?.retired, false);
    assert.equal(trace.getOp(2)?.gid, 12);
    // flush命令はretired-op索引へ入れず、正常retireだけをseqNum順に並べる。
    assert.equal(trace.getOpFromRID(0)?.gid, 10);
    assert.equal(trace.getOpFromRID(1)?.gid, 12);
});

test("Web gem5 parser restores dependencies from rename logs", async () => {
    const contents = [
        "O3PipeView:fetch:1000:0x10:0:10: producer",
        "1500: system.cpu.rename: [tid:0]: Renaming arch reg 1 (IntRegClass) to physical reg 152 (152). [sn:10]",
        "O3PipeView:decode:2000",
        "O3PipeView:complete:3000",
        "O3PipeView:retire:4000",
        "O3PipeView:fetch:5000:0x11:0:11: consumer",
        "5500: system.cpu.rename: [tid:0]: Looking up IntRegClass arch reg 1, got phys reg 152 (IntRegClass) [sn:11]",
        "O3PipeView:decode:6000",
        "O3PipeView:complete:7000",
        "O3PipeView:retire:8000",
    ].join("\n");
    const trace = await new Gem5O3PipeViewParser().parse(
        new File([contents], "rename-dependency.log", { type: "text/plain" }),
    );
    const producer = trace.getOp(0);
    const consumer = trace.getOp(1);
    assert.ok(producer);
    assert.ok(consumer);

    // 同じphysical registerへのrenameをproducer/consumerの両方向へ結び付ける。
    assert.deepEqual(consumer.prods.map((dependency) => dependency.opID), [0]);
    assert.deepEqual(producer.cons.map((dependency) => dependency.opID), [1]);
    // 追加ログ原文は、その時点で開いていたstageのtooltipにも残す。
    assert.match(producer.lanes["0"]?.stages[0].labels ?? "", /Renaming arch reg 1/);
    assert.match(consumer.lanes["0"]?.stages[0].labels ?? "", /Looking up IntRegClass/);
});

test("Web gem5 parser cancels its input stream through an AbortSignal", async () => {
    const lines = ["O3PipeView:fetch:1000:0x10:0:10: pending op"];
    while (lines.length < 8192) {
        lines.push("ordinary log line");
    }
    const contents = `${lines.join("\n")}\n`;
    const file = new File([contents], "cancel-gem5.log", { type: "text/plain" });
    let streamCanceled = false;
    Object.defineProperty(file, "stream", { value: () => new ReadableStream<Uint8Array>({
        start(controller) {
            // 有効な形式を公開した後でEOFだけを保留し、途中drain前のcancelを確認する。
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
    const parsing = new Gem5O3PipeViewParser().parse(
        file,
        () => notifyProgress?.(),
        undefined,
        controller.signal,
    );

    await progressReached;
    controller.abort();
    await assert.rejects(parsing, /File loading was canceled/);
    assert.equal(streamCanceled, true);
});
