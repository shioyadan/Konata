import assert from "node:assert/strict";
import test from "node:test";

import { Op } from "../src/core/model";
import { ArrayOpStore, type OpStore } from "../src/core/op_store";

function createOp(id: number, rid = -1): Op {
    const op = new Op();
    op.id = id;
    op.rid = rid;
    return op;
}

test("ArrayOpStore keeps sparse IDs and the retired-op index", () => {
    // IDに穴があっても最後のIDと実在する命令数を混同せず、RIDはOp本体ではなくIDへ結ぶ。
    const store = new ArrayOpStore();
    const first = createOp(0, 0);
    const last = createOp(8, 3);
    store.setOp(first.id, first);
    store.setRetiredOp(first.rid, first);
    store.setOp(last.id, last);
    store.setRetiredOp(last.rid, last);

    assert.equal(store.lastID, 8);
    assert.equal(store.lastRID, 3);
    assert.equal(store.opCount, 2);
    assert.equal(store.getOp(1), undefined);
    assert.equal(store.getOpFromRID(0), first);
    assert.equal(store.getOpFromRID(3), last);
    assert.equal(store.getOpFromRID(2), undefined);

    // 同じIDへの書き戻しは置換であり、命令数を増やさない。
    const replacement = createOp(8, 3);
    replacement.labelName = "updated";
    store.setOp(replacement.id, replacement);
    assert.equal(store.opCount, 2);
    assert.equal(store.getOp(8)?.labelName, "updated");
});

test("ArrayOpStore preserves synchronous resolution lookup behind its interface", () => {
    const mutableStore = new ArrayOpStore();
    const blockHead = createOp(4);
    mutableStore.setOp(blockHead.id, blockHead);
    // 旧OpListは丸める前にlastID範囲を検査するため、照会IDより後ろの命令も置く。
    mutableStore.setOp(8, createOp(8));

    // 旧OpListと同様、resolution=1では4命令単位の先頭へIDを丸める。
    const store: OpStore = mutableStore;
    assert.equal(store.getOp(6, 1), blockHead);
    assert.equal(store.getOp(6, 0), undefined);

    // close後はtabから参照されていたOpと索引を解放し、初期状態へ戻る。
    store.close();
    assert.equal(store.lastID, -1);
    assert.equal(store.lastRID, -1);
    assert.equal(store.opCount, 0);
    assert.equal(store.getOp(4), undefined);
});
