import assert from "node:assert/strict";
import test from "node:test";

import { Op } from "../src/core/model";
import { createStats, GenericStats, X86Gem5Stats } from "../src/core/stats";

function op(labelName: string, retired = false, flush = false): Op {
    const value = new Op();
    value.labelName = labelName;
    value.retired = retired;
    value.flush = flush;
    return value;
}

test("GenericStats preserves flush attribution and instruction counts", () => {
    const stats = new GenericStats(4, 2, 10);

    // branch直後の連続flushは一度の予測missとして数え、その列に含まれる命令数は別に数える。
    stats.update(op(" bne x1, x2 ", true));
    stats.update(op(" add x3, x4 ", false, true));
    stats.update(op(" add x5, x6 ", false, true));
    // 非flush命令を挟んだstore直後のflushは、別のflush列かつmemory missとして扱う。
    stats.update(op(" sw x1, 0(x2) ", true));
    stats.update(op(" add x7, x8 ", false, true));
    stats.finish();

    assert.deepEqual(
        {
            numFetchedOps: stats.stats.numFetchedOps,
            numCommittedOps: stats.stats.numCommittedOps,
            numCycles: stats.stats.numCycles,
            numFlush: stats.stats.numFlush,
            numFlushedOps: stats.stats.numFlushedOps,
            numBrPredMiss: stats.stats.numBrPredMiss,
            numBrFlushedOps: stats.stats.numBrFlushedOps,
            numSpeculativeMemMiss: stats.stats.numSpeculativeMemMiss,
            numSpeculativeMemFlushedOps: stats.stats.numSpeculativeMemFlushedOps,
            rateBrPredMiss: stats.stats.rateBrPredMiss,
            mpkiBrPred: stats.stats.mpkiBrPred,
            ipc: stats.stats.ipc,
        },
        {
            // 現行版は件数ではなく最終ID/RIDをこの三つの基礎値へそのまま格納する。
            numFetchedOps: 4,
            numCommittedOps: 2,
            numCycles: 10,
            numFlush: 2,
            numFlushedOps: 3,
            numBrPredMiss: 1,
            numBrFlushedOps: 2,
            numSpeculativeMemMiss: 1,
            numSpeculativeMemFlushedOps: 1,
            rateBrPredMiss: 1,
            mpkiBrPred: 500,
            ipc: 0.2,
        },
    );
});

test("X86Gem5Stats preserves x86 detection and instruction patterns", () => {
    const stats = new X86Gem5Stats(3, 2, 10);
    assert.equal(stats.isDetected, false);

    // 汎用レジスタ同士の命令でx86を判定し、gem5のwrip表現を分岐・ジャンプへ分類する。
    stats.update(op("mov eax, ebx", true));
    stats.update(op("je target: wrip", true));
    stats.update(op("jmp target: wrip", true));
    stats.update(op("store: st", true));

    assert.equal(stats.name, "X86_Gem5_Stats");
    assert.equal(stats.isDetected, true);
    assert.equal(stats.stats.numFetchedBr, 1);
    assert.equal(stats.stats.numFetchedJump, 1);
    assert.equal(stats.stats.numFetchedStore, 1);
});

test("createStats keeps the current detector priority", () => {
    // UIはisDetectedになった先頭候補を選ぶため、x86固有版を汎用版より先に保つ。
    assert.deepEqual(
        createStats(0, 0, 0).map((stats) => stats.name),
        ["X86_Gem5_Stats", "GenericStats"],
    );
});
