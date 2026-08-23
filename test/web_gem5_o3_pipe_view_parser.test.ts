import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { FileLineReader } from "../src/core/file_line_reader";
import { Gem5O3PipeViewParser } from "../src/core/gem5_o3_pipe_view_parser";

function fileFromFixture(relativePath: string): File {
    const filePath = path.resolve(import.meta.dirname, "..", relativePath);
    const contents = fs.readFileSync(filePath);
    // Bufferの共有poolではなく、fixture自身のbyte範囲だけをFileへ渡す。
    const bytes = new Uint8Array(contents.buffer, contents.byteOffset, contents.byteLength);
    return new File([bytes], path.basename(filePath), { type: "text/plain" });
}

// 形式Parser単体でも、入力媒体はFileLineReaderの境界で渡す。
function reader(file: File): FileLineReader {
    return new FileLineReader(file);
}

interface Gem5ParserDrainState {
    readonly parsingExLogs_: Map<number, unknown>;
    readonly parsingExLogLastGID_: number;
    readonly lastGID_: number;
}

test("Web gem5 parser preserves ticks and pipeline stages", async () => {
    // 旧Parserと共通のfixtureを使い、seqNumからのID/RID割り当てとtick変換を比較する。
    const trace = await new Gem5O3PipeViewParser().parse(
        reader(fileFromFixture("test/fixtures/gem5-basic.txt")),
    );

    assert.equal(trace.lastID, 0);
    assert.equal(trace.lastRID, 0);
    assert.equal(trace.lastCycle, 7);
    assert.equal(trace.opCount, 1);
    assert.deepEqual([...trace.laneNames], ["0"]);
    // UIはこの列挙からCustom色の追加候補を作るため、変換後のstage順を明示する。
    assert.deepEqual(
        trace.stageLevelMap.getStageNames("0"),
        ["F", "Dc", "Rn", "Ds", "Is", "Cm", "Rt"],
    );

    const op = trace.getOp(0);
    assert.ok(op);
    const mainLaneID = trace.stageLevelMap.getLaneID("0");
    assert.notEqual(mainLaneID, undefined);
    // 最小tick差分1000を1 cycleとし、先頭tickをcycle 0へ合わせる現行仕様を固定する。
    assert.deepEqual(
        {
            id: op.id,
            gid: op.gid,
            tid: op.tid,
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
            tid: 0,
            rid: 0,
            retired: true,
            flush: false,
            fetchedCycle: 0,
            retiredCycle: 7,
            consCycle: 5,
            prodCycle: 5,
        },
    );
    assert.equal(op.labelName, "0x00001000:  add r1, r2");
    // retireはCmを閉じ、同じtickから1 cycle幅のRt stageを追加し、命令終端も揃える。
    assert.deepEqual(
        op.lanes[mainLaneID]?.stages.map((stage) => [stage.name, stage.startCycle, stage.endCycle]),
        [
            ["F", 0, 1],
            ["Dc", 1, 2],
            ["Rn", 2, 3],
            ["Ds", 3, 4],
            ["Is", 4, 5],
            ["Cm", 5, 6],
            ["Rt", 6, 7],
        ],
    );
});

test("Web gem5 parser reads thread IDs with backward-compatible fallbacks", async () => {
    const contents = [
        "O3PipeView:fetch:1000:0x10:0:10: explicit-thread",
        "O3PipeView:thread:1000:2",
        // 詳細ログと矛盾しても、O3PipeViewの明示recordを優先する。
        "1500: system.cpu.rename: [tid:1]: Processing instruction [sn:10]",
        "O3PipeView:decode:2000",
        "O3PipeView:retire:3000",
        "O3PipeView:fetch:4000:0x11:0:11: inferred-thread",
        "4500: system.cpu.rename: [tid:3]: Processing instruction [sn:11]",
        "O3PipeView:decode:5000",
        "O3PipeView:retire:6000",
        "O3PipeView:fetch:7000:0x12:0:12: legacy-thread",
        "O3PipeView:decode:8000",
        "O3PipeView:retire:9000",
    ].join("\n");
    const trace = await new Gem5O3PipeViewParser().parse(
        reader(new File([contents], "thread-ids.log", { type: "text/plain" })),
    );

    assert.equal(trace.getOp(0)?.tid, 2);
    assert.equal(trace.getOp(1)?.tid, 3);
    assert.equal(trace.getOp(2)?.tid, 0);
});

test("Web gem5 parser rejects input without O3PipeView records", async () => {
    // 上位の形式フォールバックが判別できる英語errorを返し、空のtraceとして受理しない。
    const file = new File(["ordinary log line\n"], "ordinary.log", { type: "text/plain" });
    let updateCount = 0;
    await assert.rejects(
        new Gem5O3PipeViewParser().parse(reader(file), undefined, () => updateCount++),
        /not a gem5 O3PipeView trace/,
    );
    // O3PipeView recordを確認するまでは、fallback対象の空traceを画面へ公開しない。
    assert.equal(updateCount, 0);
});

test("Web gem5 parser publishes one trace only after detecting its format", async () => {
    const partialTraces: object[] = [];
    const trace = await new Gem5O3PipeViewParser().parse(
        reader(fileFromFixture("test/fixtures/gem5-basic.txt")),
        undefined,
        (partialTrace) => partialTraces.push(partialTrace),
    );

    // 最初のO3PipeView recordと最終drainで、同じstoreを持つtraceだけを通知する。
    assert.ok(partialTraces.length >= 2);
    assert.ok(partialTraces.every((partialTrace) => partialTrace === trace));
    assert.equal(trace.opCount, 1);
    assert.equal(trace.lastCycle, 7);
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
        reader(new File([lines.join("\n")], "out-of-order.log", { type: "text/plain" })),
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
        reader(new File([contents], "rename-dependency.log", { type: "text/plain" })),
    );
    const producer = trace.getOp(0);
    const consumer = trace.getOp(1);
    assert.ok(producer);
    assert.ok(consumer);
    const mainLaneID = trace.stageLevelMap.getLaneID("0");
    assert.notEqual(mainLaneID, undefined);

    // 同じphysical registerへのrenameをconsumerからproducerへ結び付ける。
    assert.deepEqual(consumer.prods.map((dependency) => dependency.opID), [0]);
    // 追加ログ原文は、その時点で開いていたstageのtooltipにも残す。
    assert.match(producer.lanes[mainLaneID]?.stages[0].labels ?? "", /Renaming arch reg 1/);
    assert.match(consumer.lanes[mainLaneID]?.stages[0].labels ?? "", /Looking up IntRegClass/);
});

test("Web gem5 parser does not treat missing intermediate stage ticks as a flush", async () => {
    const contents = [
        "O3PipeView:fetch:1000:0x10:0:10: nop",
        "O3PipeView:decode:2000",
        "O3PipeView:rename:3000",
        "O3PipeView:dispatch:4000",
        "O3PipeView:issue:0",
        "O3PipeView:complete:0",
        "O3PipeView:retire:5000:store:0",
    ].join("\n");
    const trace = await new Gem5O3PipeViewParser().parse(
        reader(new File([contents], "retired-nop.log", { type: "text/plain" })),
    );
    const op = trace.getOp(0);
    assert.ok(op);
    assert.equal(op.retired, true);
    assert.equal(op.flush, false);
    assert.equal(trace.lastRID, 0);
    assert.deepEqual(
        op.lanes[trace.stageLevelMap.getLaneID("0") ?? -1]?.stages.map((stage) => stage.name),
        ["F", "Dc", "Rn", "Ds", "Rt"],
    );
});

test("Web gem5 parser restores dependencies for underscored register classes", async () => {
    const contents = [
        "O3PipeView:fetch:1000:0x10:0:10: producer",
        "1500: system.cpu.rename: [tid:0]: Renaming arch reg 1 (condition_code) to physical reg 152 (152). [sn:10]",
        "O3PipeView:decode:2000",
        "O3PipeView:complete:3000",
        "O3PipeView:retire:4000:store:0",
        "O3PipeView:fetch:5000:0x11:0:11: consumer",
        "5500: system.cpu.rename: [tid:0]: Looking up condition_code arch reg 1, got phys reg 152 (condition_code) [sn:11]",
        "O3PipeView:decode:6000",
        "O3PipeView:complete:7000",
        "O3PipeView:retire:8000:store:0",
    ].join("\n");
    const trace = await new Gem5O3PipeViewParser().parse(
        reader(new File([contents], "underscore-register.log", { type: "text/plain" })),
    );
    assert.deepEqual(trace.getOp(1)?.prods.map((dependency) => dependency.opID), [0]);
});

test("Web gem5 parser preserves retire suffix ticks while aligning the drawing end", async () => {
    const contents = [
        "O3PipeView:fetch:1000:0x10:3:10: store",
        "O3PipeView:decode:2000",
        "O3PipeView:complete:3000",
        // store completionはCPU clock境界に揃わず、同cycle内の順序を下位tickで持ち得る。
        "O3PipeView:retire:4000:store:5001",
    ].join("\n");
    const trace = await new Gem5O3PipeViewParser().parse(
        reader(new File([contents], "store-tick.log", { type: "text/plain" })),
    );
    assert.match(trace.getOp(0)?.labelDetail ?? "", /Micro PC: 3/);
    assert.match(trace.getOp(0)?.labelDetail ?? "", /Retired Tick: 4000/);
    assert.match(trace.getOp(0)?.labelDetail ?? "", /Store Tick: 5001/);
    const op = trace.getOp(0);
    assert.ok(op);
    assert.equal(op.retiredCycle, 4);
    assert.equal(trace.lastCycle, 4);
    assert.equal(trace.stageLevelMap.getLaneID("memory"), undefined);
    assert.equal(op.lanes.some((lane) => lane?.stages.some((stage) => stage.name === "Sc")), false);
});

test("Web gem5 parser preserves memory completion at and after retire as raw detail", async () => {
    const contents = [
        "4000: system.cpu.memDep0: Completed mem instruction [sn:10].",
        "9000: system.cpu.memDep0: Completed mem instruction [sn:11].",
        "O3PipeView:fetch:1000:0x10:0:10: equal-retire",
        "O3PipeView:decode:2000",
        "O3PipeView:complete:3000",
        "O3PipeView:retire:4000:store:0",
        "O3PipeView:fetch:5000:0x11:0:11: after-retire",
        "O3PipeView:decode:6000",
        "O3PipeView:complete:7000",
        "O3PipeView:retire:8000:store:0",
    ].join("\n");
    const trace = await new Gem5O3PipeViewParser().parse(
        reader(new File([contents], "late-memory-complete.log", { type: "text/plain" })),
    );
    for (let id = 0; id < 2; id++) {
        const op = trace.getOp(id);
        assert.ok(op);
        assert.match(op.labelDetail, /Memory Complete: .*Completed mem instruction/);
        assert.equal(op.lanes.some((lane) => lane?.stages.some((stage) => stage.name === "Mc")), false);
    }
    assert.equal(trace.getOp(1)?.retiredCycle, 8);
    assert.equal(trace.lastCycle, 8);
    const mainLaneID = trace.stageLevelMap.getLaneID("0") ?? -1;
    assert.ok(trace.getOp(1)?.lanes[mainLaneID]?.stages.some(
        (stage) => /Completed mem instruction/.test(stage.labels),
    ));
});

test("Web gem5 parser keeps a pre-retire memory completion as the existing Mc stage", async () => {
    const contents = [
        "6000: system.cpu.memDep0: Completed mem instruction [sn:10].",
        "O3PipeView:fetch:1000:0x10:0:10: load",
        "O3PipeView:decode:3000",
        "O3PipeView:complete:5000",
        "O3PipeView:retire:7000:store:0",
    ].join("\n");
    const trace = await new Gem5O3PipeViewParser().parse(
        reader(new File([contents], "pre-retire-memory-complete.log", { type: "text/plain" })),
    );
    const op = trace.getOp(0);
    assert.ok(op);
    const mainLaneID = trace.stageLevelMap.getLaneID("0") ?? -1;
    assert.deepEqual(
        op.lanes[mainLaneID]?.stages.map((stage) => [stage.name, stage.startCycle, stage.endCycle]),
        [
            ["F", 0, 2],
            ["Dc", 2, 4],
            ["Cm", 4, 5],
            ["Mc", 5, 6],
            ["Rt", 6, 7],
        ],
    );
    assert.match(op.labelDetail, /Memory Complete: .*Completed mem instruction/);
    assert.equal(trace.lastCycle, 7);
});

test("Web gem5 parser does not backdate Mc when extra logs are not tick ordered", async () => {
    const contents = [
        "9000: system.cpu.memDep0: Completed mem instruction [sn:10].",
        "6000: system.cpu.memDep0: Completed mem instruction [sn:10].",
        "O3PipeView:fetch:1000:0x10:0:10: load",
        "O3PipeView:decode:3000",
        "O3PipeView:complete:7000",
        "O3PipeView:retire:8000:store:0",
    ].join("\n");
    const trace = await new Gem5O3PipeViewParser().parse(
        reader(new File([contents], "unordered-memory-complete.log", { type: "text/plain" })),
    );
    const op = trace.getOp(0);
    assert.ok(op);
    assert.equal(op.labelDetail.match(/Memory Complete:/g)?.length, 2);
    const stages = op.lanes[trace.stageLevelMap.getLaneID("0") ?? -1]?.stages ?? [];
    assert.equal(stages.some((stage) => stage.name === "Mc"), false);
    assert.equal(stages.some((stage) => stage.endCycle < stage.startCycle), false);
    assert.equal(
        stages.some((stage, index) => index > 0 && stage.startCycle < stages[index - 1].startCycle),
        false,
    );
});

test("Web gem5 parser normalizes replayed stage ticks without losing the raw tick", async () => {
    const contents = [
        "O3PipeView:fetch:1000:0x10:0:10: replayed-load",
        "O3PipeView:decode:2000",
        "O3PipeView:rename:3000",
        "O3PipeView:dispatch:4000",
        "O3PipeView:issue:9000",
        "O3PipeView:complete:5000",
        "O3PipeView:retire:0:store:0",
    ].join("\n");
    const trace = await new Gem5O3PipeViewParser().parse(
        reader(new File([contents], "replayed-stage.log", { type: "text/plain" })),
    );
    const op = trace.getOp(0);
    assert.ok(op);
    const stages = op.lanes[trace.stageLevelMap.getLaneID("0") ?? -1]?.stages ?? [];
    assert.equal(op.flush, true);
    assert.equal(stages.some((stage) => stage.endCycle < stage.startCycle), false);
    assert.equal(
        stages.some((stage, index) => index > 0 && stage.startCycle < stages[index - 1].startCycle),
        false,
    );
    assert.match(op.labelDetail, /Out-of-order complete Tick: 5000 \(normalized to 9000\)/);
});

test("Web gem5 parser discards late extra logs for globally drained sequence numbers", async () => {
    const firstSeqNum = 100000;
    const lines: string[] = [];
    for (let index = 0; index < 20000; index++) {
        const seqNum = firstSeqNum + index;
        const fetchTick = index * 2000 + 1000;
        lines.push(
            `O3PipeView:fetch:${fetchTick}:0x${seqNum.toString(16)}:0:${seqNum}: op ${seqNum}`,
            `O3PipeView:retire:${fetchTick + 1000}`,
        );
    }
    // FileLineReaderの5回目の定期yield直前を遅延ログにし、EOFを待たず内部状態を検査する。
    while (lines.length < 40959) {
        lines.push("ordinary log line");
    }
    lines.push(`${lines.length * 1000}: system.cpu.rename: late log [sn:${firstSeqNum}]`);

    const contents = `${lines.join("\n")}\n`;
    const file = new File([contents], "late-extra-log.log", { type: "text/plain" });
    let streamCanceled = false;
    Object.defineProperty(file, "stream", { value: () => new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(new TextEncoder().encode(contents));
        },
        cancel() {
            streamCanceled = true;
        },
    }) });

    const parser = new Gem5O3PipeViewParser();
    // このテストは公開結果では観測できない、長い読込み中の一時Map解放を固定する。
    const drainState = parser as unknown as Gem5ParserDrainState;
    let notifyLateLog: (() => void) | null = null;
    const lateLogParsed = new Promise<void>((resolve) => {
        notifyLateLog = resolve;
    });
    const controller = new AbortController();
    const parsing = parser.parse(
        reader(file),
        () => {
            if (drainState.parsingExLogLastGID_ === firstSeqNum) {
                notifyLateLog?.();
            }
        },
        undefined,
        controller.signal,
    );

    await lateLogParsed;
    assert.ok(drainState.lastGID_ >= firstSeqNum);
    assert.equal(drainState.parsingExLogs_.has(firstSeqNum), false);
    controller.abort();
    await assert.rejects(parsing, /File loading was canceled/);
    assert.equal(streamCanceled, true);
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
        reader(file),
        () => notifyProgress?.(),
        undefined,
        controller.signal,
    );

    await progressReached;
    controller.abort();
    await assert.rejects(parsing, /File loading was canceled/);
    assert.equal(streamCanceled, true);
});
