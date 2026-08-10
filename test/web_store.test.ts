import assert from "node:assert/strict";
import test from "node:test";

import { Op, ParsedTrace, StageLevelMap } from "../src/core/model";
import { ArrayOpStore } from "../src/core/op_store";
import {
    DEFAULT_CUSTOM_COLOR_SCHEME,
    DEP_ARROW_TYPE,
    KonataRenderer,
} from "../src/renderer/konata_renderer";
import { type Change, Store } from "../src/store";

function createTrace(fileName: string): { trace: ParsedTrace; opStore: ArrayOpStore } {
    const op = new Op();
    op.id = 0;
    const opStore = new ArrayOpStore();
    opStore.setOp(op.id, op);
    return {
        trace: new ParsedTrace(fileName, opStore, new StageLevelMap(), 0),
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
    assert.equal(firstTab.loadSignal.aborted, false);
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
    // traceの有無にかかわらず、閉じたTabだけの入力処理へcancelを通知する。
    assert.equal(firstTab.loadSignal.aborted, true);
    assert.equal(secondTab.loadSignal.aborted, false);
    assert.equal(first.opStore.opCount, 0);
    assert.equal(second.opStore.opCount, 1);
    assert.ok(changes.some((change) => change.type === "PANE_CONTENT_UPDATE"));
    assert.ok(changes.some((change) => change.type === "TAB_CLOSE" && change.tabID === firstTab.id));

    unsubscribe();
    store.close();
    assert.equal(second.opStore.opCount, 0);
    assert.equal(store.getSnapshot().tabs.length, 0);
});

test("Store reloads a trace in place and restores its view", () => {
    const store = new Store();
    const changes: Change[] = [];
    store.subscribeChange((change) => changes.push(change));

    store.dispatch({ type: "FILE_OPEN", fileName: "reload.log", renderer: new KonataRenderer() });
    const tab = store.activeTab;
    assert.ok(tab !== null && tab.kind === "trace");
    const first = createTrace("reload.log");
    store.dispatch({ type: "FILE_LOAD_FINISH", tabID: tab.id, trace: first.trace });
    tab.renderer.zoomAbs(-1, 0, 0, false);
    tab.renderer.moveLogicalPosition([12, 4]);
    const firstSignal = tab.loadSignal;

    store.dispatch({ type: "FILE_RELOAD", tabID: tab.id });

    assert.equal(store.activeTab, tab);
    assert.equal(tab.loadState, "loading");
    assert.equal(tab.progress, 0);
    assert.equal(tab.trace, null);
    assert.equal(firstSignal.aborted, true);
    assert.equal(tab.loadSignal.aborted, false);
    assert.equal(first.opStore.opCount, 0);

    const second = createTrace("reload.log");
    store.dispatch({ type: "FILE_LOAD_FINISH", tabID: tab.id, trace: second.trace });
    assert.equal(tab.trace, second.trace);
    assert.equal(tab.renderer.zoomLevel, -1);
    assert.deepEqual(tab.renderer.viewPosition, [12, 4]);
    assert.ok(changes.some((change) =>
        change.type === "PROGRESS_BAR_START" && change.tabID === tab.id && change.operation === "load"));

    store.close();
    assert.equal(second.opStore.opCount, 0);
});

test("Comparison tabs share source OpStores until the last view is closed", () => {
    const store = new Store();

    store.dispatch({ type: "FILE_OPEN", fileName: "baseline.log", renderer: new KonataRenderer() });
    const baselineTab = store.activeTab;
    assert.ok(baselineTab !== null && baselineTab.kind === "trace");
    const baseline = createTrace("baseline.log");
    const baselineOp = baseline.trace.getOp(0);
    assert.ok(baselineOp !== undefined);
    baselineOp.rid = 0;
    baselineOp.retired = true;
    baselineOp.fetchedCycle = 10;
    baseline.opStore.setRetiredOp(0, baselineOp);
    store.dispatch({ type: "FILE_LOAD_FINISH", tabID: baselineTab.id, trace: baseline.trace });
    baselineTab.renderer.moveLogicalPosition([12, 0]);
    baselineTab.renderer.changeColorScheme("RoyalBlue");

    store.dispatch({ type: "FILE_OPEN", fileName: "candidate.log", renderer: new KonataRenderer() });
    const candidateTab = store.activeTab;
    assert.ok(candidateTab !== null && candidateTab.kind === "trace");
    const candidate = createTrace("candidate.log");
    const candidateOp = candidate.trace.getOp(0);
    assert.ok(candidateOp !== undefined);
    candidateOp.rid = 0;
    candidateOp.retired = true;
    candidateOp.fetchedCycle = 20;
    candidate.opStore.setRetiredOp(0, candidateOp);
    store.dispatch({ type: "FILE_LOAD_FINISH", tabID: candidateTab.id, trace: candidate.trace });
    candidateTab.renderer.zoomAbs(-1, 0, 0, false);
    candidateTab.renderer.moveLogicalPosition([25, 8]);
    candidateTab.renderer.changeColorScheme("Custom");

    store.dispatch({
        type: "COMPARISON_OPEN",
        baselineTabID: baselineTab.id,
        candidateTabID: candidateTab.id,
    });
    const comparison = store.activeTab;
    assert.ok(comparison !== null && comparison.kind === "comparison");
    assert.equal(comparison.baselineTrace, baseline.trace);
    assert.equal(comparison.trace, candidate.trace);
    assert.notEqual(comparison.baselineRenderer, baselineTab.renderer);
    assert.notEqual(comparison.renderer, candidateTab.renderer);
    // Renderer自身には元Tabの通常配色を引き継ぎ、比較専用色は描画時だけ上書きする。
    assert.equal(comparison.baselineRenderer.colorScheme, "RoyalBlue");
    assert.equal(comparison.renderer.colorScheme, "Custom");
    store.dispatch({
        type: "KONATA_CHANGE_COLOR_SCHEME",
        tabID: comparison.id,
        scheme: "DarkOrange",
    });
    // Store上の通常配色はA/Bへ同時に反映し、比較専用色から通常表示へ戻せるようにする。
    assert.equal(comparison.baselineRenderer.colorScheme, "DarkOrange");
    assert.equal(comparison.renderer.colorScheme, "DarkOrange");
    assert.deepEqual(comparison.renderer.viewPosition, [25, 8]);
    // 比較開始時は各元Tabの位置を保ち、overlayに必要な倍率だけを揃える。
    assert.deepEqual(comparison.baselineRenderer.viewPosition, [12, 0]);
    assert.equal(comparison.baselineRenderer.zoomLevel, -1);
    store.dispatch({ type: "COMPARISON_SET_MODE", tabID: comparison.id, mode: "baseline" });
    store.dispatch({ type: "COMPARISON_SET_OPACITY", tabID: comparison.id, opacity: 2 });
    assert.equal(comparison.mode, "baseline");
    assert.equal(comparison.opacity, 1);
    store.dispatch({ type: "COMPARISON_ALIGN_TO_BASELINE", tabID: comparison.id });
    // まずAをAdjust positionでRID 0のfetchへ戻し、Bの同じRIDも左上へ置く。
    assert.deepEqual(comparison.baselineRenderer.viewPosition, [10, 0]);
    assert.deepEqual(comparison.renderer.viewPosition, [20, 0]);
    store.dispatch({
        type: "KONATA_MUTATE_VIEW",
        tabID: comparison.id,
        mutation: (renderer) => renderer.moveLogicalDifference([2, 3], false),
        baselineMutation: (renderer) => renderer.moveLogicalDifference([2, 3], false),
    });
    // RIDを探し直さず、両Rendererの現在位置へ同じ移動量を加える。
    assert.deepEqual(comparison.renderer.viewPosition, [22, 3]);
    assert.deepEqual(comparison.baselineRenderer.viewPosition, [12, 3]);
    store.dispatch({
        type: "KONATA_MUTATE_VIEW",
        tabID: comparison.id,
        baselineMutation: (renderer) => renderer.moveLogicalDifference([1, 0], false),
    });
    // A単独表示のpanはAだけを動かし、薄いBを位置合わせの基準として残す。
    assert.deepEqual(comparison.renderer.viewPosition, [22, 3]);
    assert.deepEqual(comparison.baselineRenderer.viewPosition, [13, 3]);
    store.dispatch({ type: "COMPARISON_SET_MODE", tabID: comparison.id, mode: "candidate" });
    store.dispatch({
        type: "KONATA_MUTATE_VIEW",
        tabID: comparison.id,
        mutation: (renderer) => renderer.moveLogicalDifference([0, 2], false),
    });
    // B単独表示では逆にBだけを動かせる。
    assert.deepEqual(comparison.renderer.viewPosition, [22, 5]);
    assert.deepEqual(comparison.baselineRenderer.viewPosition, [13, 3]);

    // 元Tabを両方閉じても、比較Tabがretainした同じTrace／OpStoreは利用可能なままにする。
    store.dispatch({ type: "TAB_CLOSE", tabID: baselineTab.id });
    store.dispatch({ type: "TAB_CLOSE", tabID: candidateTab.id });
    assert.equal(store.activeTab, comparison);
    assert.equal(baseline.opStore.opCount, 1);
    assert.equal(candidate.opStore.opCount, 1);
    assert.equal(comparison.baselineTrace?.getOp(0), baselineOp);
    assert.equal(comparison.trace?.getOp(0), candidateOp);

    store.dispatch({ type: "TAB_CLOSE", tabID: comparison.id });
    assert.equal(baseline.opStore.opCount, 0);
    assert.equal(candidate.opStore.opCount, 0);
    assert.equal(store.activeTab, null);
});

test("Store moves the active tab forward and backward without reordering tabs", () => {
    const store = new Store();
    for (const fileName of ["first.log", "second.log", "third.log"]) {
        store.dispatch({ type: "FILE_OPEN", fileName, renderer: new KonataRenderer() });
    }

    const tabIDs = store.getSnapshot().tabs.map((tab) => tab.id);
    assert.equal(store.activeTab?.fileName, "third.log");
    // 末尾の次は先頭へ、先頭の前は末尾へ戻る旧TAB_MOVEの循環を固定する。
    store.dispatch({ type: "TAB_MOVE", next: true });
    assert.equal(store.activeTab?.fileName, "first.log");
    store.dispatch({ type: "TAB_MOVE", next: false });
    assert.equal(store.activeTab?.fileName, "third.log");
    store.dispatch({ type: "TAB_MOVE", next: false });
    assert.equal(store.activeTab?.fileName, "second.log");
    // active Tabだけを変更し、表示順そのものは変更しない。
    assert.deepEqual(store.getSnapshot().tabs.map((tab) => tab.id), tabIDs);

    store.close();
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

test("Store keeps search context per tab and rejects stale search updates", () => {
    const store = new Store();
    const changes: Change[] = [];
    store.subscribeChange((change) => changes.push(change));

    store.dispatch({ type: "FILE_OPEN", fileName: "first.log", renderer: new KonataRenderer() });
    const firstTab = store.activeTab;
    assert.ok(firstTab !== null);
    const first = createTrace("first.log");
    store.dispatch({ type: "FILE_LOAD_FINISH", tabID: firstTab.id, trace: first.trace });
    const foundOp = first.trace.getOp(0);
    assert.ok(foundOp !== undefined);

    store.dispatch({ type: "KONATA_FIND_START", tabID: firstTab.id, targetPattern: "first" });
    const firstRequestID = firstTab.findContext.requestID;
    store.dispatch({
        type: "KONATA_FIND_PROGRESS",
        tabID: firstTab.id,
        requestID: firstRequestID,
        progress: 0.5,
    });
    store.dispatch({
        type: "KONATA_FIND_FINISH",
        tabID: firstTab.id,
        requestID: firstRequestID,
        result: {
            targetPattern: "first",
            foundString: "first result",
            op: foundOp,
            anchorOp: foundOp,
            flushed: false,
        },
        message: "",
    });

    store.dispatch({ type: "FILE_OPEN", fileName: "second.log", renderer: new KonataRenderer() });
    const secondTab = store.activeTab;
    assert.ok(secondTab !== null);
    // 新しいTabには別のcontextを作り、元のTabへ戻ると検索条件と結果を復元する。
    assert.equal(secondTab.findContext.result, null);
    store.dispatch({ type: "TAB_ACTIVATE", tabID: firstTab.id });
    assert.equal(store.activeTab?.findContext.targetPattern, "first");
    assert.equal(store.activeTab?.findContext.result?.foundString, "first result");

    store.dispatch({ type: "KONATA_FIND_START", tabID: firstTab.id, targetPattern: "new" });
    const secondRequestID = firstTab.findContext.requestID;
    // 新しい検索開始後に前の結果が到着しても、request IDが異なる更新は採用しない。
    store.dispatch({
        type: "KONATA_FIND_FINISH",
        tabID: firstTab.id,
        requestID: firstRequestID,
        result: {
            targetPattern: "stale",
            foundString: "stale result",
            op: foundOp,
            anchorOp: foundOp,
            flushed: false,
        },
        message: "",
    });
    assert.equal(firstTab.findContext.requestID, secondRequestID);
    assert.equal(firstTab.findContext.result, null);
    assert.equal(firstTab.findContext.progress, 0);

    store.dispatch({ type: "KONATA_FIND_HIDE_RESULT", tabID: firstTab.id });
    assert.equal(firstTab.findContext.progress, null);
    assert.ok(changes.some((change) =>
        change.type === "PROGRESS_BAR_START" && change.operation === "search"));
    assert.ok(changes.some((change) =>
        change.type === "PROGRESS_BAR_UPDATE" && change.operation === "search"));
    assert.ok(changes.some((change) =>
        change.type === "PROGRESS_BAR_FINISH" && change.operation === "search"));

    store.close();
});

test("Store restores and publishes persistent view settings", () => {
    const store = new Store({
        theme: "light",
        colorScheme: "RoyalBlue",
        customColorScheme: DEFAULT_CUSTOM_COLOR_SCHEME,
        splitterPosition: 321,
        dependencyArrowType: DEP_ARROW_TYPE.LEFT_SIDE_CURVE,
        textLabelMinimumLaneHeight: 11,
        stageDetailMinimumLaneHeight: 2,
        dependencyArrowMinimumLaneHeight: 5,
        stageBorderMinimumLaneHeight: 6,
        drawZoomFactor: 1.5,
    });
    const changes: Change[] = [];
    store.subscribeChange((change) => changes.push(change));
    const restored = store.getSnapshot().settings;
    assert.equal(restored.theme, "light");
    assert.equal(restored.dependencyArrowType, DEP_ARROW_TYPE.LEFT_SIDE_CURVE);
    assert.equal(restored.textLabelMinimumLaneHeight, 11);
    assert.equal(restored.drawZoomFactor, 1.5);
    // lane分割と固定高さは旧Configの保存対象ではなく、再起動時には初期値へ戻る。
    assert.equal(restored.splitLanes, false);
    assert.equal(restored.fixOpHeight, false);

    const renderer = new KonataRenderer();
    store.dispatch({ type: "FILE_OPEN", fileName: "restored.log", renderer });
    const tab = store.activeTab;
    assert.ok(tab !== null);
    assert.equal(tab.splitterPosition, 321);
    assert.equal(renderer.colorScheme, "RoyalBlue");
    assert.equal(renderer.theme, "light");

    store.dispatch({ type: "KONATA_CHANGE_UI_COLOR_THEME", theme: "dark" });
    store.dispatch({ type: "KONATA_SET_DEP_ARROW_TYPE", arrowType: DEP_ARROW_TYPE.NOT_SHOW });
    store.dispatch({
        type: "KONATA_CHANGE_MINIMUM_LANE_HEIGHT",
        setting: "textLabelMinimumLaneHeight",
        value: 14,
    });
    store.dispatch({ type: "PANE_SPLITTER_MOVE", tabID: tab.id, position: 280 });
    store.dispatch({ type: "KONATA_CHANGE_COLOR_SCHEME", tabID: tab.id, scheme: "Custom" });
    const customColorScheme = {
        ...DEFAULT_CUSTOM_COLOR_SCHEME,
        defaultColor: { ...DEFAULT_CUSTOM_COLOR_SCHEME.defaultColor, h: 210 },
    };
    store.dispatch({ type: "KONATA_CHANGE_CUSTOM_COLORS", scheme: customColorScheme });
    store.dispatch({ type: "KONATA_CHANGE_ZOOM_FACTOR", value: 2 });
    store.dispatch({ type: "KONATA_SPLIT_LANES", enabled: true });
    store.dispatch({ type: "KONATA_FIX_OP_HEIGHT", enabled: true });
    store.dispatch({ type: "KONATA_HIDE_FLUSHED_OPS", tabID: tab.id, enabled: true });

    assert.deepEqual(store.persistedViewSettings, {
        theme: "dark",
        colorScheme: "Custom",
        customColorScheme,
        splitterPosition: 280,
        dependencyArrowType: DEP_ARROW_TYPE.NOT_SHOW,
        textLabelMinimumLaneHeight: 14,
        stageDetailMinimumLaneHeight: 2,
        dependencyArrowMinimumLaneHeight: 5,
        stageBorderMinimumLaneHeight: 6,
        drawZoomFactor: 2,
    });
    // Tab固有設定や旧Storeだけの一時設定では、永続化通知を増やさない。
    assert.equal(changes.filter((change) => change.type === "VIEW_SETTINGS_UPDATE").length, 7);

    store.close();
});

test("Store separates global view settings from tab-specific settings", () => {
    const store = new Store();
    const changes: Change[] = [];
    store.subscribeChange((change) => changes.push(change));

    const firstRenderer = new KonataRenderer();
    store.dispatch({ type: "FILE_OPEN", fileName: "first.log", renderer: firstRenderer });
    const firstTab = store.activeTab;
    assert.ok(firstTab !== null);
    store.dispatch({
        type: "KONATA_CHANGE_COLOR_SCHEME",
        tabID: firstTab.id,
        scheme: "Custom",
    });
    store.dispatch({ type: "KONATA_HIDE_FLUSHED_OPS", tabID: firstTab.id, enabled: true });

    store.dispatch({ type: "KONATA_CHANGE_UI_COLOR_THEME", theme: "light" });
    store.dispatch({
        type: "KONATA_SET_DEP_ARROW_TYPE",
        arrowType: DEP_ARROW_TYPE.LEFT_SIDE_CURVE,
    });
    store.dispatch({ type: "KONATA_SPLIT_LANES", enabled: true });
    store.dispatch({ type: "KONATA_FIX_OP_HEIGHT", enabled: true });
    store.dispatch({
        type: "KONATA_CHANGE_MINIMUM_LANE_HEIGHT",
        setting: "textLabelMinimumLaneHeight",
        value: 12,
    });

    const secondRenderer = new KonataRenderer();
    store.dispatch({ type: "FILE_OPEN", fileName: "second.log", renderer: secondRenderer });
    const secondTab = store.activeTab;
    assert.ok(secondTab !== null);

    // 全体設定は既存Rendererと新しいRendererの双方へ同じ値を適用する。
    for (const renderer of [firstRenderer, secondRenderer]) {
        assert.equal(renderer.theme, "light");
        assert.equal(renderer.dependencyArrowType, DEP_ARROW_TYPE.LEFT_SIDE_CURVE);
        assert.equal(renderer.splitLanes, true);
        assert.equal(renderer.fixOpHeight, true);
        assert.equal(renderer.textLabelMinimumLaneHeight, 12);
    }
    assert.equal(store.getSnapshot().settings.theme, "light");
    assert.ok(changes.some((change) => change.type === "WINDOW_CSS_UPDATE"));
    assert.ok(changes.some((change) =>
        change.type === "PANE_CONTENT_UPDATE" && change.tabID === null));

    // Custom定義は全体設定なので、既存の全Rendererへ同じ値を即時反映する。
    const customColorScheme = {
        ...DEFAULT_CUSTOM_COLOR_SCHEME,
        defaultColor: { ...DEFAULT_CUSTOM_COLOR_SCHEME.defaultColor, h: 210 },
    };
    store.dispatch({ type: "KONATA_CHANGE_CUSTOM_COLORS", scheme: customColorScheme });
    assert.deepEqual(firstRenderer.customColorScheme, customColorScheme);
    assert.deepEqual(secondRenderer.customColorScheme, customColorScheme);

    // 色方式は最後の選択を新規Tabの既定値にするが、変更対象は指定したTabだけに限る。
    assert.equal(firstRenderer.colorScheme, "Custom");
    assert.equal(secondRenderer.colorScheme, "Custom");
    store.dispatch({
        type: "KONATA_CHANGE_COLOR_SCHEME",
        tabID: secondTab.id,
        scheme: "RoyalBlue",
    });
    assert.equal(firstRenderer.colorScheme, "Custom");
    assert.equal(secondRenderer.colorScheme, "RoyalBlue");

    // flush非表示は旧Tabと同じく新規Tabへ引き継がず、各Tabで独立させる。
    assert.equal(firstRenderer.hideFlushedOps, true);
    assert.equal(secondRenderer.hideFlushedOps, false);

    store.close();
});

test("Store keeps splitter positions per tab and carries the latest position to new tabs", () => {
    const store = new Store();
    const changes: Change[] = [];
    store.subscribeChange((change) => changes.push(change));

    store.dispatch({ type: "FILE_OPEN", fileName: "first.log", renderer: new KonataRenderer() });
    const firstTab = store.activeTab;
    assert.ok(firstTab !== null);
    // 初期値450pxは旧Configに合わせ、移動後も対象Tabだけを書き換える。
    assert.equal(firstTab.splitterPosition, 450);
    store.dispatch({ type: "PANE_SPLITTER_MOVE", tabID: firstTab.id, position: 320 });
    assert.equal(firstTab.splitterPosition, 320);

    store.dispatch({ type: "FILE_OPEN", fileName: "second.log", renderer: new KonataRenderer() });
    const secondTab = store.activeTab;
    assert.ok(secondTab !== null);
    // 旧Configと同様、新しく開くTabは最後に選んだ幅から開始する。
    assert.equal(secondTab.splitterPosition, 320);
    store.dispatch({ type: "PANE_SPLITTER_MOVE", tabID: secondTab.id, position: 280 });
    assert.equal(firstTab.splitterPosition, 320);
    assert.equal(secondTab.splitterPosition, 280);
    assert.ok(changes.some((change) =>
        change.type === "PANE_SIZE_UPDATE" && change.tabID === secondTab.id));

    store.close();
});
