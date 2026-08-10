import assert from "node:assert/strict";
import test from "node:test";

import { Lane, Op, ParsedTrace, Stage, StageLevelMap } from "../src/core/model";
import { ArrayOpStore } from "../src/core/op_store";
import {
    COMPARISON_COLOR_SCHEME,
    DEFAULT_CUSTOM_COLOR_SCHEME,
    formatOpLabel,
    KonataRenderer,
} from "../src/renderer/konata_renderer";

interface RecordedGradient {
    readonly points: [number, number, number, number];
    readonly stops: Array<[number, string]>;
}

interface RecordedContext {
    readonly fillTexts: Array<[string, number, number]>;
    readonly gradients: RecordedGradient[];
    readonly context: CanvasRenderingContext2D;
}

function createRecordedContext(): RecordedContext {
    const fillTexts: Array<[string, number, number]> = [];
    const gradients: RecordedGradient[] = [];
    const context = {
        fillStyle: "",
        strokeStyle: "",
        lineWidth: 1,
        font: "",
        setTransform() {},
        fillRect() {},
        strokeRect() {},
        beginPath() {},
        moveTo() {},
        lineTo() {},
        bezierCurveTo() {},
        stroke() {},
        fill() {},
        fillText(text: string, x: number, y: number) {
            fillTexts.push([text, x, y]);
        },
        createLinearGradient(x0: number, y0: number, x1: number, y1: number) {
            const gradient: RecordedGradient = { points: [x0, y0, x1, y1], stops: [] };
            gradients.push(gradient);
            return {
                addColorStop(offset: number, color: string) {
                    gradient.stops.push([offset, color]);
                },
            };
        },
    } as unknown as CanvasRenderingContext2D;
    return { fillTexts, gradients, context };
}

function createCanvas(context: CanvasRenderingContext2D, width = 320, height = 96): HTMLCanvasElement {
    return {
        width,
        height,
        clientWidth: width,
        clientHeight: height,
        getContext: (type: string) => type === "2d" ? context : null,
    } as unknown as HTMLCanvasElement;
}

function createTrace(): { trace: ParsedTrace; op: Op; stage: Stage } {
    const op = new Op();
    op.id = 0;
    op.gid = 100;
    op.rid = 0;
    op.tid = 1;
    op.retired = true;
    op.fetchedCycle = 2;
    op.retiredCycle = 9;
    op.line = 12;
    op.labelName = "add x1, x2, x3";
    op.labelDetail = "detail";

    const stage = new Stage();
    stage.name = "X";
    stage.labels = "executing";
    stage.startCycle = 2;
    stage.endCycle = 5;
    const lane = new Lane();
    lane.stages.push(stage);

    const levelMap = new StageLevelMap();
    const laneID = levelMap.getOrCreateLaneID("0");
    op.lanes[laneID] = lane;
    levelMap.update("0", "X", lane);
    const store = new ArrayOpStore();
    store.setOp(0, op);
    store.setRetiredOp(0, op);
    return {
        trace: new ParsedTrace("trace.log", store, levelMap, 9),
        op,
        stage,
    };
}

test("Web renderer keeps the legacy instruction label format", () => {
    const { op } = createTrace();
    // 左paneはfile-local ID、global ID、thread、retire ID、命令ラベルの順で表示する。
    assert.equal(formatOpLabel(op.id, op), "0: s100 (t1: r0): add x1, x2, x3");
});

test("Web renderer draws stage names and elapsed cycles like the legacy renderer", () => {
    const { trace } = createTrace();
    const renderer = new KonataRenderer();
    renderer.setTrace(trace);
    const label = createRecordedContext();
    const pipeline = createRecordedContext();

    renderer.draw(createCanvas(label.context), createCanvas(pipeline.context));

    // 3-cycleのX stageは先頭にX、後続cycleに1と2を個別に表示する。
    assert.deepEqual(
        pipeline.fillTexts.map(([text]) => text).sort(),
        ["1", "2", "X"],
    );
    // 色はcycle方向ではなく、旧Rendererと同じstage上端から下端へのgradientにする。
    assert.deepEqual(pipeline.gradients[0]?.points, [0, 0.5, 0, 24.5]);
    assert.equal(pipeline.gradients[0]?.stops.length, 2);
});

test("Web renderer preserves legacy zoom levels and lane heights", () => {
    const { trace, op } = createTrace();
    const secondLane = new Lane();
    const secondStage = new Stage();
    secondStage.name = "Wb";
    secondStage.startCycle = 5;
    secondStage.endCycle = 6;
    secondLane.stages.push(secondStage);
    const secondLaneID = trace.stageLevelMap.getOrCreateLaneID("1");
    op.lanes[secondLaneID] = secondLane;
    trace.stageLevelMap.update("1", "Wb", secondLane);

    const renderer = new KonataRenderer();
    renderer.setTrace(trace);
    renderer.zoomAt(1.2, 0, 0);
    assert.equal(renderer.zoomLevel, -1);
    assert.equal(renderer.zoomPercent, 200);
    renderer.zoomAt(1 / 1.2, 0, 0);
    assert.equal(renderer.zoomLevel, 0);
    assert.equal(renderer.zoomPercent, 100);

    // 大幅な縮小時も0%と表示せず、倍率の違いが読み取れる精度を残す。
    renderer.zoomAbs(8, 0, 0, false);
    assert.equal(renderer.zoomPercentLabel, "0.391%");
    renderer.zoomAbs(24, 0, 0, false);
    assert.equal(renderer.zoomPercentLabel, "6.0e-6%");
    renderer.resetView();

    // lane分割時は既定でlane数に応じて命令行を高くし、高さ固定時だけ24pxへ戻す。
    renderer.splitLanes = true;
    assert.equal(renderer.opHeight, 48);
    renderer.fixOpHeight = true;
    assert.equal(renderer.opHeight, 24);
});

test("Web renderer finds an instruction anchor for position adjustment", () => {
    const { trace } = createTrace();
    const renderer = new KonataRenderer();
    renderer.setTrace(trace);
    renderer.zoomAbs(8, 0, 0, false);

    // 横方向だけを見失った場合は、上端命令のfetch cycleへ倍率を変えずに戻せる。
    renderer.moveLogicalPosition([100, 0]);
    assert.deepEqual(renderer.getAdjustedViewPosition(), [2, 0]);
    assert.deepEqual(renderer.viewPosition, [100, 0]);
    assert.equal(renderer.zoomLevel, 8);

    // 上下方向も範囲外なら、短いtraceでも先頭命令を復帰先にできる。
    renderer.moveLogicalPosition([100, -10]);
    assert.deepEqual(renderer.getAdjustedViewPosition(), [2, 0]);
    renderer.moveLogicalPosition([100, 10]);
    assert.deepEqual(renderer.getAdjustedViewPosition(), [2, 0]);
});

test("Web renderer preserves legacy tooltip contents", () => {
    const { trace } = createTrace();
    const renderer = new KonataRenderer();
    renderer.setTrace(trace);

    const labelText = renderer.getLabelToolTipText(0);
    assert.match(labelText ?? "", /Line: \t\t12/);
    assert.match(labelText ?? "", /Serial ID:\t100/);

    // cycle 3はX stageの2cycle目なので、stage長3とstage labelを表示する。
    const pipelineText = renderer.getPipelineToolTipText(3 * KonataRenderer.OP_W, 0);
    assert.match(pipelineText ?? "", /^\[3, 0\] X\[3\]/);
    assert.match(pipelineText ?? "", /X: executing/);
});

test("Web renderer applies the legacy light theme and Custom color scheme", () => {
    const { trace } = createTrace();
    const renderer = new KonataRenderer();
    renderer.setTrace(trace);
    renderer.setTheme("light");
    renderer.changeColorScheme("Custom");
    const label = createRecordedContext();
    const pipeline = createRecordedContext();

    renderer.draw(createCanvas(label.context), createCanvas(pipeline.context));

    assert.equal(renderer.theme, "light");
    assert.equal(renderer.colorScheme, "Custom");
    // Customで未指定のX stageは、旧Configの既定hue 100とlight themeの彩度・明度を組み合わせる。
    assert.deepEqual(pipeline.gradients[0]?.stops, [
        [0, "hsl(100,95%,95%)"],
        [1, "hsl(100,70%,80%)"],
    ]);

    // 編集した既定色は未指定stageへ即時反映され、固定した彩度・明度はtheme値で上書きしない。
    renderer.setCustomColorSchemes({
        Custom: {
            ...DEFAULT_CUSTOM_COLOR_SCHEME,
            defaultColor: { h: 210, s: 25, l: 60 },
        },
    });
    const editedPipeline = createRecordedContext();
    renderer.draw(createCanvas(createRecordedContext().context), createCanvas(editedPipeline.context));
    assert.deepEqual(editedPipeline.gradients[0]?.stops, [
        [0, "hsl(210,25%,60%)"],
        [1, "hsl(210,25%,60%)"],
    ]);
});

test("Web renderer uses comparison colors without changing the View color scheme", () => {
    const { trace, stage } = createTrace();
    const renderer = new KonataRenderer();
    renderer.setTrace(trace);
    renderer.changeColorScheme("Custom");

    const baseline = createRecordedContext();
    renderer.drawPipeline(
        createCanvas(baseline.context),
        undefined,
        undefined,
        COMPARISON_COLOR_SCHEME.OVERLAY_BASELINE,
    );
    const candidate = createRecordedContext();
    renderer.drawPipeline(
        createCanvas(candidate.context),
        undefined,
        undefined,
        COMPARISON_COLOR_SCHEME.OVERLAY_CANDIDATE,
    );
    stage.name = "Y";
    const changedCandidate = createRecordedContext();
    renderer.drawPipeline(
        createCanvas(changedCandidate.context),
        undefined,
        undefined,
        COMPARISON_COLOR_SCHEME.OVERLAY_CANDIDATE,
    );
    const difference = createRecordedContext();
    renderer.drawPipeline(
        createCanvas(difference.context),
        undefined,
        undefined,
        COMPARISON_COLOR_SCHEME.DIFFERENCE,
    );

    const parseRGB = (color: string): number[] => {
        const matched = /^rgb\((\d+),(\d+),(\d+)\)$/.exec(color);
        assert.ok(matched !== null);
        return matched.slice(1).map(Number);
    };
    const addRGB = (left: string, right: string): number[] =>
        parseRGB(left).map((component, index) => component + parseRGB(right)[index]);
    const baselineStops = baseline.gradients[0]?.stops;
    const candidateStops = candidate.gradients[0]?.stops;
    const changedCandidateStops = changedCandidate.gradients[0]?.stops;
    assert.ok(baselineStops !== undefined && candidateStops !== undefined && changedCandidateStops !== undefined);
    // 同じstage XならA/BのRGB和が無彩色となり、opacity 0.5で灰色へ揃う。
    assert.deepEqual(addRGB(baselineStops[0][1], candidateStops[0][1]), [280, 280, 280]);
    assert.deepEqual(addRGB(baselineStops[1][1], candidateStops[1][1]), [260, 260, 260]);
    // 同じ矩形でもstage名がYへ変われば相補関係が崩れ、局所的な色として残る。
    const changedSum = addRGB(baselineStops[0][1], changedCandidateStops[0][1]);
    assert.ok(changedSum.some((component) => Math.abs(component - 280) >= 20));
    assert.deepEqual(difference.gradients[0]?.stops, [
        [0, "hsl(0,0%,88%)"],
        [1, "hsl(0,0%,70%)"],
    ]);
    // 一時配色で描いた後も、A/B単独表示とView欄には元の選択が残る。
    assert.equal(renderer.colorScheme, "Custom");
});

test("Web renderer keeps minimum lane heights configurable", () => {
    const { trace } = createTrace();
    const renderer = new KonataRenderer();
    renderer.setTrace(trace);
    renderer.textLabelMinimumLaneHeight = 100;
    const label = createRecordedContext();
    const pipeline = createRecordedContext();

    renderer.draw(createCanvas(label.context), createCanvas(pipeline.context));

    // 24pxのlaneより最小高さを大きくすると、旧Settingsと同様にlabelとstage文字だけを省略する。
    assert.deepEqual(label.fillTexts, []);
    assert.deepEqual(pipeline.fillTexts, []);
    assert.equal(pipeline.gradients.length, 1);
});
