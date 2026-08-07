import assert from "node:assert/strict";
import test from "node:test";

import { Lane, Op, Stage } from "../src/core/model";
import { calculateStageRect, formatOpLabel } from "../src/renderer/konata_renderer";

function createRenderedOp(): { op: Op; stage: Stage } {
    const op = new Op();
    op.id = 3;
    op.gid = 100;
    op.rid = 2;
    op.tid = 1;
    op.labelName = "add x1, x2, x3";
    op.retiredCycle = 9;

    const stage = new Stage();
    stage.name = "X";
    stage.startCycle = 2;
    stage.endCycle = 5;
    const lane = new Lane();
    lane.stages.push(stage);
    op.lanes.set("0", lane);
    return { op, stage };
}

test("Web renderer keeps the legacy instruction label format", () => {
    const { op } = createRenderedOp();
    // 左paneはfile-local ID、global ID、thread、retire ID、命令ラベルの順で表示する。
    // 検索結果やスクリーンショットを見比べやすいよう、旧Rendererの空白と記号も維持する。
    assert.equal(formatOpLabel(op.id, op), "3: s100 (t1: r2): add x1, x2, x3");
});

test("Web renderer maps cycles and op IDs to legacy stage coordinates", () => {
    const { op, stage } = createRenderedOp();
    // 旧Rendererのscale=1は32px/cycle、24px/op。cycle 2から5のXは
    // viewport (cycle=1, op=2) から見てx=32、y=25、幅96になる。
    assert.deepEqual(calculateStageRect(op, stage, 1, 2, 1), {
        left: 32,
        top: 25,
        width: 96,
        height: 22,
    });

    // EのないstageはretiredCycleまで描き、短いstageも最低1pxを確保する。
    stage.startCycle = 9;
    stage.endCycle = 0;
    assert.deepEqual(calculateStageRect(op, stage, 9, 3, 0.5), {
        left: 0,
        top: 0.5,
        width: 1,
        height: 11,
    });
});
