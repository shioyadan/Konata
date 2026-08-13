import assert from "node:assert/strict";
import test from "node:test";

import { Lane, Op, ParsedTrace, Stage, StageLevelMap } from "../src/core/model";
import { ArrayOpStore } from "../src/core/op_store";
import {
    COMPARISON_COLOR_SCHEME,
    DEFAULT_CUSTOM_COLOR_SCHEME,
    DEFAULT_KONATA_RENDER_SPEC,
    formatOpLabel,
    formatKonataZoomPercent,
    KONATA_OP_WIDTH,
    KonataRenderMetrics,
    KonataRenderer,
} from "../src/core/konata_renderer";

interface RecordedGradient {
    readonly points: [number, number, number, number];
    readonly stops: Array<[number, string]>;
}

interface RecordedContext {
    readonly fillTexts: Array<[string, number, number]>;
    readonly fillRects: Array<[number, number, number, number]>;
    readonly fillStyles: string[];
    readonly strokeRects: Array<[number, number, number, number]>;
    readonly strokeStyles: string[];
    readonly lineWidths: number[];
    readonly clearRects: Array<[number, number, number, number]>;
    readonly gradients: RecordedGradient[];
    readonly commands: string[];
    readonly context: CanvasRenderingContext2D;
}

function createRecordedContext(): RecordedContext {
    const fillTexts: Array<[string, number, number]> = [];
    const fillRects: Array<[number, number, number, number]> = [];
    const fillStyles: string[] = [];
    const strokeRects: Array<[number, number, number, number]> = [];
    const strokeStyles: string[] = [];
    const lineWidths: number[] = [];
    const clearRects: Array<[number, number, number, number]> = [];
    const gradients: RecordedGradient[] = [];
    const commands: string[] = [];
    const context = {
        fillStyle: "",
        strokeStyle: "",
        lineWidth: 1,
        font: "",
        setTransform() {},
        fillRect(x: number, y: number, width: number, height: number) {
            commands.push("fillRect");
            fillRects.push([x, y, width, height]);
            fillStyles.push(String(this.fillStyle));
        },
        clearRect(x: number, y: number, width: number, height: number) {
            clearRects.push([x, y, width, height]);
        },
        strokeRect(x: number, y: number, width: number, height: number) {
            commands.push("strokeRect");
            strokeRects.push([x, y, width, height]);
            strokeStyles.push(String(this.strokeStyle));
            lineWidths.push(this.lineWidth);
        },
        beginPath() {},
        moveTo() {},
        lineTo() {},
        bezierCurveTo() {},
        stroke() {},
        fill() {},
        fillText(text: string, x: number, y: number) {
            commands.push(`text:${text}`);
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
    return {
        fillTexts,
        fillRects,
        fillStyles,
        strokeRects,
        strokeStyles,
        lineWidths,
        clearRects,
        gradients,
        commands,
        context,
    };
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
    const label = createRecordedContext();
    const pipeline = createRecordedContext();

    renderer.drawSpec(
        trace,
        DEFAULT_KONATA_RENDER_SPEC,
        createCanvas(label.context),
        createCanvas(pipeline.context),
    );

    // 3-cycleのX stageは先頭にX、後続cycleに1と2を個別に表示する。
    assert.deepEqual(
        pipeline.fillTexts.map(([text]) => text).sort(),
        ["1", "2", "X"],
    );
    // 色はcycle方向ではなく、旧Rendererと同じstage上端から下端へのgradientにする。
    const gradientPoints = pipeline.gradients[0]?.points;
    assert.ok(gradientPoints !== undefined);
    assert.ok(gradientPoints.every((value, index) =>
        Math.abs(value - [0, 0.5, 0, 24.5][index]) < 0.00001));
    assert.equal(pipeline.gradients[0]?.stops.length, 2);
});

test("Web renderer preserves text order between overlapping lanes in the Canvas fallback", () => {
    const { trace, op } = createTrace();
    const secondStage = new Stage();
    secondStage.name = "Y";
    secondStage.startCycle = 2;
    secondStage.endCycle = 5;
    const secondLane = new Lane();
    secondLane.stages.push(secondStage);
    const secondLaneID = trace.stageLevelMap.getOrCreateLaneID("1");
    op.lanes[secondLaneID] = secondLane;
    trace.stageLevelMap.update("1", "Y", secondLane);
    const pipeline = createRecordedContext();

    new KonataRenderer().drawPipelineSpec(
        trace,
        DEFAULT_KONATA_RENDER_SPEC,
        createCanvas(pipeline.context),
    );

    const firstLaneText = pipeline.commands.indexOf("text:X");
    const secondLaneText = pipeline.commands.indexOf("text:Y");
    assert.ok(firstLaneText >= 0 && secondLaneText > firstLaneText);
    // 後続laneの矩形を先行laneの文字より後へ残し、重ね表示のpainter順を変えない。
    assert.ok(pipeline.commands.slice(firstLaneText + 1, secondLaneText).includes("fillRect"));
});

test("Web renderer reproduces drawing from a trace and render spec", () => {
    const { trace } = createTrace();
    const renderer = new KonataRenderer();
    const spec = {
        ...DEFAULT_KONATA_RENDER_SPEC,
        position: [1, 0] as const,
        zoomLevel: -1,
        theme: "light" as const,
        colorScheme: "Custom",
    };
    const draw = () => {
        const label = createRecordedContext();
        const pipeline = createRecordedContext();
        renderer.drawSpec(
            trace,
            spec,
            createCanvas(label.context),
            createCanvas(pipeline.context),
        );
        return {
            labelTexts: label.fillTexts,
            pipelineTexts: pipeline.fillTexts,
            pipelineRects: pipeline.fillRects,
            gradients: pipeline.gradients,
        };
    };

    const first = draw();
    // 別の描画を挟んでも、TraceとSpecを再入力すれば同じ描画命令を再現する。
    renderer.drawSpec(
        trace,
        { ...DEFAULT_KONATA_RENDER_SPEC, position: [100, 100], zoomLevel: 8 },
        createCanvas(createRecordedContext().context),
        createCanvas(createRecordedContext().context),
    );
    assert.deepEqual(draw(), first);
});

test("Web render metrics preserve legacy zoom levels and lane heights", () => {
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

    const base = new KonataRenderMetrics(trace, DEFAULT_KONATA_RENDER_SPEC);
    const zoomedSpec = base.withZoomLevel(-1, 0, 0);
    const zoomed = new KonataRenderMetrics(trace, zoomedSpec);
    assert.equal(zoomed.zoomLevel, -1);
    assert.equal(zoomed.zoomScale * 100, 200);
    const restored = new KonataRenderMetrics(trace, zoomed.withZoomLevel(0, 0, 0));
    assert.equal(restored.zoomLevel, 0);
    assert.equal(restored.zoomScale * 100, 100);

    // 大幅な縮小時も0%と表示せず、倍率の違いが読み取れる精度を残す。
    assert.equal(formatKonataZoomPercent(8), "0.391%");
    assert.equal(formatKonataZoomPercent(24), "6.0e-6%");

    // lane分割時は既定でlane数に応じて命令行を高くし、高さ固定時だけ24pxへ戻す。
    const split = new KonataRenderMetrics(trace, {
        ...DEFAULT_KONATA_RENDER_SPEC,
        splitLanes: true,
    });
    assert.equal(split.opHeight, 48);
    const fixed = new KonataRenderMetrics(trace, {
        ...split.spec,
        fixOpHeight: true,
    });
    assert.equal(fixed.opHeight, 24);
});

test("Web render metrics find an instruction anchor for position adjustment", () => {
    const { trace } = createTrace();

    // 横方向だけを見失った場合は、上端命令のfetch cycleへ倍率を変えずに戻せる。
    const metrics = new KonataRenderMetrics(trace, {
        ...DEFAULT_KONATA_RENDER_SPEC,
        position: [100, 0],
        zoomLevel: 8,
    });
    assert.deepEqual(metrics.getAdjustedViewPosition(), [2, 0]);
    assert.deepEqual(metrics.spec.position, [100, 0]);
    assert.equal(metrics.zoomLevel, 8);

    // 上下方向も範囲外なら、短いtraceでも先頭命令を復帰先にできる。
    assert.deepEqual(
        new KonataRenderMetrics(trace, metrics.withPosition([100, -10])).getAdjustedViewPosition(),
        [2, 0],
    );
    assert.deepEqual(
        new KonataRenderMetrics(trace, metrics.withPosition([100, 10])).getAdjustedViewPosition(),
        [2, 0],
    );
});

test("Web render metrics preserve legacy tooltip contents", () => {
    const { trace } = createTrace();
    const metrics = new KonataRenderMetrics(trace, DEFAULT_KONATA_RENDER_SPEC);

    const labelText = metrics.getLabelToolTipText(0);
    assert.match(labelText ?? "", /Line: \t\t12/);
    assert.match(labelText ?? "", /Serial ID:\t100/);

    // cycle 3はX stageの2cycle目なので、stage長3とstage labelを表示する。
    const pipelineText = metrics.getPipelineToolTipText(3 * KONATA_OP_WIDTH, 0);
    assert.match(pipelineText ?? "", /^\[3, 0\] X\[3\]/);
    assert.match(pipelineText ?? "", /X: executing/);
});

test("Web renderer applies the legacy light theme and Custom color scheme", () => {
    const { trace } = createTrace();
    const renderer = new KonataRenderer();
    const spec = {
        ...DEFAULT_KONATA_RENDER_SPEC,
        theme: "light" as const,
        colorScheme: "Custom",
    };
    const label = createRecordedContext();
    const pipeline = createRecordedContext();

    renderer.drawSpec(trace, spec, createCanvas(label.context), createCanvas(pipeline.context));

    // Customで未指定のX stageは、旧Configの既定hue 100とlight themeの彩度・明度を組み合わせる。
    assert.deepEqual(pipeline.gradients[0]?.stops, [
        [0, "hsl(100,95%,95%)"],
        [1, "hsl(100,70%,80%)"],
    ]);

    // 編集した既定色は未指定stageへ即時反映され、固定した彩度・明度はtheme値で上書きしない。
    const editedSpec = {
        ...spec,
        customColorScheme: {
            ...DEFAULT_CUSTOM_COLOR_SCHEME,
            defaultColor: { h: 210, s: 25, l: 60 },
        },
    };
    const editedPipeline = createRecordedContext();
    renderer.drawSpec(
        trace,
        editedSpec,
        createCanvas(createRecordedContext().context),
        createCanvas(editedPipeline.context),
    );
    assert.deepEqual(editedPipeline.gradients[0]?.stops, [
        [0, "hsl(210,25%,60%)"],
        [1, "hsl(210,25%,60%)"],
    ]);
});

test("Web renderer uses comparison colors without changing the View color scheme", () => {
    const { trace, stage } = createTrace();
    const renderer = new KonataRenderer();
    const spec = { ...DEFAULT_KONATA_RENDER_SPEC, colorScheme: "Custom" };

    const baseline = createRecordedContext();
    renderer.drawPipelineSpec(
        trace,
        spec,
        createCanvas(baseline.context),
        undefined,
        undefined,
        COMPARISON_COLOR_SCHEME.OVERLAY_BASELINE,
    );
    const candidate = createRecordedContext();
    renderer.drawPipelineSpec(
        trace,
        spec,
        createCanvas(candidate.context),
        undefined,
        undefined,
        COMPARISON_COLOR_SCHEME.OVERLAY_CANDIDATE,
    );
    stage.name = "Y";
    const changedCandidate = createRecordedContext();
    renderer.drawPipelineSpec(
        trace,
        spec,
        createCanvas(changedCandidate.context),
        undefined,
        undefined,
        COMPARISON_COLOR_SCHEME.OVERLAY_CANDIDATE,
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
    // 比較色は一時的な描画引数なので、正式なSpecの選択値は変わらない。
    assert.equal(spec.colorScheme, "Custom");
});

test("Web renderer draws a transparent gray reference for single-side comparison", () => {
    const { trace } = createTrace();
    const renderer = new KonataRenderer();
    const reference = createRecordedContext();

    renderer.drawPipelineSpec(
        trace,
        DEFAULT_KONATA_RENDER_SPEC,
        createCanvas(reference.context),
        undefined,
        undefined,
        COMPARISON_COLOR_SCHEME.REFERENCE,
        true,
    );

    // 参照側は背景、stage名、枠線を省き、位置合わせに必要なstage形状だけを灰色で残す。
    assert.deepEqual(reference.clearRects, [[0, 0, 320, 96]]);
    assert.equal(reference.fillRects.length, 1);
    assert.deepEqual(reference.fillTexts, []);
    assert.deepEqual(reference.gradients[0]?.stops, [
        [0, "rgb(210,210,210)"],
        [1, "rgb(210,210,210)"],
    ]);
});

test("Web renderer keeps minimum lane heights configurable", () => {
    const { trace } = createTrace();
    const renderer = new KonataRenderer();
    const label = createRecordedContext();
    const pipeline = createRecordedContext();

    renderer.drawSpec(
        trace,
        { ...DEFAULT_KONATA_RENDER_SPEC, textLabelMinimumLaneHeight: 100, theme: "light" },
        createCanvas(label.context),
        createCanvas(pipeline.context),
    );

    // 24pxのlaneより最小高さを大きくすると、旧Settingsと同様にlabelとstage文字だけを省略する。
    assert.deepEqual(label.fillTexts, []);
    assert.deepEqual(pipeline.fillTexts, []);
    assert.equal(pipeline.gradients.length, 1);
});

test("Web renderer uses one solid rectangle per op at extreme zoom without WebGL", () => {
    const { trace, op } = createTrace();
    op.flush = true;
    const renderer = new KonataRenderer();
    const pipeline = createRecordedContext();

    renderer.drawPipelineSpec(
        trace,
        { ...DEFAULT_KONATA_RENDER_SPEC, zoomLevel: 5, theme: "light" },
        createCanvas(pipeline.context),
        undefined,
        undefined,
        undefined,
        false,
        { webGLEnabled: false, textCacheEnabled: true },
    );

    // stage数に比例させず、命令色を1回描いてからflush色を同じ範囲へ重ねる。
    const opRectIndex = pipeline.fillStyles.indexOf("#888888");
    assert.ok(opRectIndex >= 0);
    assert.equal(pipeline.fillStyles[opRectIndex + 1], "rgba(0,0,0,0.4)");
    assert.deepEqual(pipeline.fillRects[opRectIndex], pipeline.fillRects[opRectIndex + 1]);
    assert.deepEqual(pipeline.fillTexts, []);
    assert.deepEqual(pipeline.gradients, []);
});

test("Web renderer keeps stage borders in the accelerated Canvas fallback", () => {
    const { trace } = createTrace();
    const renderer = new KonataRenderer();
    const pipeline = createRecordedContext();

    renderer.drawPipelineSpec(
        trace,
        { ...DEFAULT_KONATA_RENDER_SPEC, zoomLevel: 1, theme: "light" },
        createCanvas(pipeline.context),
    );

    // 50%では文字を省略する一方、塗りと同じ矩形へlight themeの1px枠を残す。
    const stageRectIndex = pipeline.fillStyles.indexOf("[object Object]");
    assert.ok(stageRectIndex >= 0);
    assert.deepEqual(pipeline.strokeRects, [pipeline.fillRects[stageRectIndex]]);
    assert.deepEqual(pipeline.strokeStyles, ["#444444"]);
    assert.deepEqual(pipeline.lineWidths, [1]);
    assert.deepEqual(pipeline.fillTexts, []);
});
