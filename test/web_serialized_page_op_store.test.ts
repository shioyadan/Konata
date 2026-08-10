import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { Dependency, Lane, Op, Stage } from "../src/core/model";
import { OnikiriParser } from "../src/core/onikiri_parser";
import { SerializedPageOpStore } from "../src/core/serialized_page_op_store";

function createComplexOp(): Op {
    const op = new Op();
    op.id = 0;
    op.gid = 10;
    op.rid = 2;
    op.tid = 1;
    op.retired = true;
    op.flush = true;
    op.eof = true;
    op.fetchedCycle = 3;
    op.retiredCycle = 12;
    op.line = 4;
    op.labelName = "add x1, x2, x3";
    op.labelDetail = "detail\nline";
    op.lastParsedCycle = 11;
    op.prodCycle = 8;
    op.consCycle = 6;
    op.prods.push(new Dependency(7, 1, 8));
    op.cons.push(new Dependency(9, 2, 10));

    const mainLane = new Lane();
    mainLane.level = 2;
    const fetch = new Stage();
    fetch.name = "F";
    fetch.startCycle = 3;
    fetch.endCycle = 5;
    mainLane.stages.push(fetch);
    op.lanes["0"] = mainLane;

    const subLane = new Lane();
    subLane.level = 1;
    const execute = new Stage();
    execute.name = "X";
    execute.labels = "ALU";
    execute.startCycle = 6;
    execute.endCycle = 9;
    subLane.stages.push(execute);
    op.lanes["1"] = subLane;
    op.lastParsedStage = execute;
    return op;
}

test("SerializedPageOpStore restores the complete mutable Op model", () => {
    // 1 Op/page、展開page 1枚に制限し、別IDの追加で必ずserialize/deserializeを通す。
    const store = new SerializedPageOpStore({
        pageSizeBits: 0,
        maxDecodedPages: 1,
        levelSpans: [1],
    });
    const original = createComplexOp();
    store.setOp(original.id, original);
    store.setRetiredOp(original.rid, original);
    const other = new Op();
    other.id = 1;
    store.setOp(other.id, other);

    assert.equal(store.serializedPageCount, 1);
    assert.equal(store.decodedPageCount, 1);
    const restored = store.getOp(0);
    assert.ok(restored);
    assert.notEqual(restored, original);
    assert.deepEqual(
        {
            id: restored.id,
            gid: restored.gid,
            rid: restored.rid,
            tid: restored.tid,
            retired: restored.retired,
            flush: restored.flush,
            eof: restored.eof,
            fetchedCycle: restored.fetchedCycle,
            retiredCycle: restored.retiredCycle,
            line: restored.line,
            labelName: restored.labelName,
            labelDetail: restored.labelDetail,
            lastParsedCycle: restored.lastParsedCycle,
            prodCycle: restored.prodCycle,
            consCycle: restored.consCycle,
        },
        {
            id: 0,
            gid: 10,
            rid: 2,
            tid: 1,
            retired: true,
            flush: true,
            eof: true,
            fetchedCycle: 3,
            retiredCycle: 12,
            line: 4,
            labelName: "add x1, x2, x3",
            labelDetail: "detail\nline",
            lastParsedCycle: 11,
            prodCycle: 8,
            consCycle: 6,
        },
    );
    assert.deepEqual(
        Object.entries(restored.lanes).map(([name, lane]) => ({
            name,
            level: lane.level,
            stages: lane.stages.map((stage) => ({ ...stage })),
        })),
        [
            { name: "0", level: 2, stages: [{ name: "F", labels: "", startCycle: 3, endCycle: 5 }] },
            { name: "1", level: 1, stages: [{ name: "X", labels: "ALU", startCycle: 6, endCycle: 9 }] },
        ],
    );
    assert.deepEqual(restored.prods.map((dependency) => ({ ...dependency })), [
        { opID: 7, type: 1, cycle: 8 },
    ]);
    assert.deepEqual(restored.cons.map((dependency) => ({ ...dependency })), [
        { opID: 9, type: 2, cycle: 10 },
    ]);
    // lastParsedStageは値が同じ別objectではなく、復元したlane内Stageへの参照に戻す。
    assert.equal(Object.getPrototypeOf(restored.lanes), null);
    assert.equal(restored.lastParsedStage, restored.lanes["1"]?.stages[0]);
    assert.equal(store.getOpFromRID(2), restored);
    assert.equal(store.getOp(1, 1), restored);

    // 取得結果の変更をsetOpで書き戻せば、再度pageを追い出しても変更が残る。
    restored.labelDetail += "; updated";
    store.setOp(restored.id, restored);
    store.getOp(1);
    assert.equal(store.getOp(0)?.labelDetail, "detail\nline; updated");
});

test("SerializedPageOpStore stores independently decodable Zstandard pages", async () => {
    // 既存のpage退避条件は変えず、保存表現だけをzstd frameへ差し替えて往復を確認する。
    const store = await SerializedPageOpStore.createZstd({
        pageSizeBits: 0,
        maxDecodedPages: 1,
        levelSpans: [1],
    });
    const original = createComplexOp();
    store.setOp(original.id, original);
    const other = new Op();
    other.id = 1;
    store.setOp(other.id, other);

    const metrics = store.levelMetrics[0];
    assert.equal(store.pageCodec, "zstd");
    assert.equal(metrics.serializedPages, 1);
    assert.equal(metrics.serializeCount, 1);
    assert.ok(metrics.storedSize < metrics.serializedCharacters);
    assert.equal(store.getOp(0)?.labelDetail, original.labelDetail);
    assert.equal(store.levelMetrics[0].decodeCount, 1);
});

test("SerializedPageOpStore uses coarse pages and both LRU layers", () => {
    // 1 Op/pageにすると、最後のID以外は必ずserialize済みになる。
    const store = new SerializedPageOpStore({
        pageSizeBits: 0,
        maxDecodedPages: 1,
        maxCachedOps: 1,
        levelSpans: [1, 8, 64],
    });
    for (let id = 0; id <= 128; id++) {
        const op = new Op();
        op.id = id;
        store.setOp(id, op);
    }

    assert.deepEqual(store.levelMetrics.map((level) => level.span), [1, 8, 64]);
    const before = store.levelMetrics;
    const coarse = store.getOp(65, 5);
    assert.equal(coarse?.id, 64);
    const afterCoarse = store.levelMetrics;
    // 2^6単位へ丸めたIDは64命令間隔の階層から読み、level 0を展開しない。
    assert.equal(afterCoarse[0].decodeCount, before[0].decodeCount);
    assert.equal(afterCoarse[1].decodeCount, before[1].decodeCount);
    assert.equal(afterCoarse[2].decodeCount, before[2].decodeCount + 1);

    assert.equal(store.getOp(66, 5), coarse);
    assert.equal(store.opCacheAccessCount, 2);
    assert.equal(store.opCacheHitCount, 1);
    assert.equal(store.levelMetrics[2].decodeCount, afterCoarse[2].decodeCount);

    // Op LRUから64を追い出した後は、階層側のpage LRUから1 pageだけ再展開する。
    assert.equal(store.getOp(128, 5)?.id, 128);
    const beforeReload = store.levelMetrics[2].decodeCount;
    assert.equal(store.getOp(65, 5)?.id, 64);
    assert.equal(store.levelMetrics[2].decodeCount, beforeReload + 1);
    assert.equal(store.levelMetrics[0].decodeCount, before[0].decodeCount);

    const cacheAccessesBeforeScan = store.opCacheAccessCount;
    assert.equal(store.getOpForScan(8)?.id, 8);
    // 全走査用取得はpageを利用しても、対話操作のOp cache統計と内容を変えない。
    assert.equal(store.opCacheAccessCount, cacheAccessesBeforeScan);

    // 完了後の追記はOp cacheを無効化し、IDが対応する全階層へ同じ変更を書き戻す。
    const updated = new Op();
    updated.id = 8;
    updated.labelDetail = "updated after eviction";
    store.setOp(updated.id, updated);
    assert.equal(store.opCount, 129);
    assert.equal(store.getOp(9, 2)?.labelDetail, "updated after eviction");
});

test("OnikiriParser preserves post-retire updates through serialized pages", async () => {
    const fixturePath = path.resolve(import.meta.dirname, "fixtures", "kanata-basic.txt");
    const contents = fs.readFileSync(fixturePath);
    const bytes = new Uint8Array(contents.buffer, contents.byteOffset, contents.byteLength);
    const file = new File([bytes], "kanata-basic.txt", { type: "text/plain" });
    // 1 Op/pageにしてid=1のretire時にid=0を追い出し、末尾のretire後Lで再展開させる。
    const store = new SerializedPageOpStore({
        pageSizeBits: 0,
        maxDecodedPages: 1,
        levelSpans: [1],
    });
    const trace = await new OnikiriParser(store).parse(file);

    assert.equal(trace.lastID, 1);
    assert.equal(trace.lastRID, 0);
    assert.equal(trace.opCount, 2);
    assert.equal(trace.getOp(0)?.labelDetail, "producer detail; post-retire detail");
    assert.equal(trace.getOpFromRID(0)?.id, 0);
    assert.equal(trace.getOpFromRID(1), undefined);
});

test("OnikiriParser writes dependencies back to an evicted producer page", async () => {
    // id=1のretireでid=0をserializeした後、id=2からid=0へのWを記録する。
    // getOp()が復元したproducerは複製なので、Parserの明示的なsetOp()が必要になる。
    const contents = [
        "Kanata\t0004",
        "I\t0\t10\t0",
        "R\t0\t0\t0",
        "I\t1\t11\t0",
        "R\t1\t1\t0",
        "I\t2\t12\t0",
        "W\t2\t0\t7",
        "R\t2\t2\t0",
    ].join("\n");
    const file = new File([contents], "stored-producer.log", { type: "text/plain" });
    const store = new SerializedPageOpStore({
        pageSizeBits: 0,
        maxDecodedPages: 1,
        levelSpans: [1],
    });
    const trace = await new OnikiriParser(store).parse(file);

    assert.deepEqual(trace.getOp(0)?.cons.map((dependency) => ({ ...dependency })), [
        { opID: 2, type: 7, cycle: 0 },
    ]);
    assert.deepEqual(trace.getOp(2)?.prods.map((dependency) => ({ ...dependency })), [
        { opID: 0, type: 7, cycle: 0 },
    ]);
});
