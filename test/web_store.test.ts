import assert from "node:assert/strict";
import test from "node:test";

import { Op, ParsedTrace, StageLevelMap } from "../src/core/model";
import { ArrayOpStore } from "../src/core/op_store";
import { KonataRenderer } from "../src/renderer/konata_renderer";
import { type Change, Store } from "../src/store";

function createTrace(fileName: string): { trace: ParsedTrace; opStore: ArrayOpStore } {
    const op = new Op();
    op.id = 0;
    const opStore = new ArrayOpStore();
    opStore.setOp(op.id, op);
    return {
        trace: new ParsedTrace(fileName, opStore, new Set(), new StageLevelMap(), 0),
        opStore,
    };
}

test("Store owns tab traces, renderers, activation, and close", () => {
    const store = new Store();
    const changes: Change[] = [];
    const unsubscribe = store.subscribeChange((change) => changes.push(change));

    store.dispatch({ type: "FILE_OPEN", fileName: "first.log", renderer: new KonataRenderer() });
    const firstTab = store.activeTab;
    assert.ok(firstTab !== null);
    const first = createTrace("first.log");
    store.dispatch({ type: "FILE_LOAD_FINISH", tabID: firstTab.id, trace: first.trace });
    store.dispatch({
        type: "KONATA_MUTATE_VIEW",
        tabID: firstTab.id,
        mutation: (renderer) => renderer.zoomAbs(-1, 0, 0, false),
    });

    store.dispatch({ type: "FILE_OPEN", fileName: "second.log", renderer: new KonataRenderer() });
    const secondTab = store.activeTab;
    assert.ok(secondTab !== null);
    const second = createTrace("second.log");
    store.dispatch({ type: "FILE_LOAD_FINISH", tabID: secondTab.id, trace: second.trace });

    // IDは再利用せず、activate後も各Tabのtraceと倍率を独立して保持する。
    assert.deepEqual(store.getSnapshot().tabs.map((tab) => tab.id), [0, 1]);
    store.dispatch({ type: "TAB_ACTIVATE", tabID: firstTab.id });
    assert.equal(store.activeTab, firstTab);
    assert.equal(store.activeTab.renderer.zoomPercent, 200);

    // active tabを閉じると隣へ移り、そのTabが所有していたOpStoreだけを解放する。
    store.dispatch({ type: "TAB_CLOSE", tabID: firstTab.id });
    assert.equal(store.activeTab, secondTab);
    assert.equal(first.opStore.opCount, 0);
    assert.equal(second.opStore.opCount, 1);
    assert.ok(changes.some((change) => change.type === "PANE_CONTENT_UPDATE"));
    assert.ok(changes.some((change) => change.type === "TAB_CLOSE" && change.tabID === firstTab.id));

    unsubscribe();
    store.close();
    assert.equal(second.opStore.opCount, 0);
    assert.equal(store.getSnapshot().tabs.length, 0);
});

test("Store rejects a delayed trace update after its tab is closed", () => {
    const store = new Store();
    store.dispatch({ type: "FILE_OPEN", fileName: "closed.log", renderer: new KonataRenderer() });
    const closedTabID = store.activeTab?.id;
    assert.equal(typeof closedTabID, "number");
    store.dispatch({ type: "TAB_CLOSE", tabID: closedTabID });

    // Parserがclose後に完了しても、閉じたTabを復活させず到着したOpStoreを直ちに解放する。
    const delayed = createTrace("closed.log");
    store.dispatch({ type: "FILE_LOAD_FINISH", tabID: closedTabID, trace: delayed.trace });
    assert.equal(delayed.opStore.opCount, 0);

    // Parserが失敗して途中traceを返す場合も、同じ所有権規則で解放する。
    const delayedError = createTrace("error.log");
    store.dispatch({
        type: "FILE_LOAD_ERROR",
        tabID: closedTabID,
        message: "Delayed parser error",
        trace: delayedError.trace,
    });
    assert.equal(delayedError.opStore.opCount, 0);
    assert.equal(store.activeTab, null);
    assert.equal(store.getSnapshot().tabs.length, 0);
});
