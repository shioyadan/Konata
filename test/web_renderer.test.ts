import assert from "node:assert/strict";
import test from "node:test";

import { Dependency, Lane, Op, ParsedTrace, Stage, StageLevelMap } from "../src/core/model";
import { ArrayOpStore } from "../src/core/op_store";
import { CanvasBackend } from "../src/core/canvas_backend";
import {
    COMPARISON_COLOR_SCHEME,
    DEFAULT_CUSTOM_COLOR_SCHEME,
    DEFAULT_KONATA_RENDER_SPEC,
    formatOpLabel,
    formatKonataZoomPercent,
    getFirstDrawingRow,
    getVisibilityLevelForMinimumLaneHeight,
    KONATA_OP_WIDTH,
    KonataRenderMetrics,
    KonataRenderer,
} from "../src/core/konata_renderer";
import {
    KonataViewController,
    type KonataAnimationScheduler,
    type KonataViewFrame,
} from "../src/core/konata_view_controller";

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
    readonly pathStrokeStyles: string[];
    readonly pathFillStyles: string[];
    readonly pathLineWidths: number[];
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
    const pathStrokeStyles: string[] = [];
    const pathFillStyles: string[] = [];
    const pathLineWidths: number[] = [];
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
        beginPath() {
            commands.push("beginPath");
        },
        moveTo(x: number, y: number) {
            commands.push(`moveTo:${x},${y}`);
        },
        lineTo(x: number, y: number) {
            commands.push(`lineTo:${x},${y}`);
        },
        bezierCurveTo(
            controlPoint1X: number,
            controlPoint1Y: number,
            controlPoint2X: number,
            controlPoint2Y: number,
            x: number,
            y: number,
        ) {
            commands.push(
                `bezierCurveTo:${controlPoint1X},${controlPoint1Y},` +
                `${controlPoint2X},${controlPoint2Y},${x},${y}`,
            );
        },
        stroke() {
            commands.push("stroke");
            pathStrokeStyles.push(String(this.strokeStyle));
            pathLineWidths.push(this.lineWidth);
        },
        fill() {
            commands.push("fill");
            pathFillStyles.push(String(this.fillStyle));
        },
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
        pathStrokeStyles,
        pathFillStyles,
        pathLineWidths,
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

function createLatencyTrace(ranges: readonly (readonly [number, number])[]): ParsedTrace {
    const store = new ArrayOpStore();
    ranges.forEach(([fetchedCycle, retiredCycle], id) => {
        const op = new Op();
        op.id = id;
        op.rid = id;
        op.retired = true;
        op.fetchedCycle = fetchedCycle;
        op.retiredCycle = retiredCycle;
        store.setOp(id, op);
        store.setRetiredOp(id, op);
    });
    return new ParsedTrace("latency.log", store, new StageLevelMap(), 1000);
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

test("Web renderer skips elapsed-cycle text left of a long stage viewport", () => {
    const { trace, op, stage } = createTrace();
    op.fetchedCycle = 0;
    op.retiredCycle = 1000;
    stage.startCycle = 0;
    stage.endCycle = 1000;
    const pipeline = createRecordedContext();

    new KonataRenderer().drawPipelineSpec(
        trace,
        { ...DEFAULT_KONATA_RENDER_SPEC, position: [200.5, 0] },
        createCanvas(pipeline.context),
    );

    // 左端に一部かかる200から右端の210だけを残し、画面外の1..199はbackendへ渡さない。
    assert.deepEqual(
        pipeline.fillTexts
            .map(([text]) => text)
            .filter((text) => /^\d+$/.test(text)),
        Array.from({ length: 11 }, (_, index) => String(200 + index)),
    );
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
    assert.deepEqual([
        base.spec.textLabelMinimumLaneHeight,
        base.spec.stageDetailMinimumLaneHeight,
        base.spec.dependencyArrowMinimumLaneHeight,
        base.spec.stageBorderMinimumLaneHeight,
    ].map(getVisibilityLevelForMinimumLaneHeight), [3, 11, 5, 5]);
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

    // 0.069%付近ではRendererとタイル空判定の双方が30命令おきの代表だけを見る。
    const overview = new KonataRenderMetrics(trace, {
        ...DEFAULT_KONATA_RENDER_SPEC,
        zoomLevel: 10.5,
    });
    assert.equal(formatKonataZoomPercent(overview.zoomLevel), "0.0691%");
    assert.equal(overview.drawingStep, 30);

    // 0.0781%では約26命令おきになるが、tile上端が端数でもtrace全体の位相へ揃える。
    const seamOverview = new KonataRenderMetrics(trace, {
        ...DEFAULT_KONATA_RENDER_SPEC,
        zoomLevel: Math.log2(1280),
    });
    assert.equal(formatKonataZoomPercent(seamOverview.zoomLevel), "0.0781%");
    assert.equal(seamOverview.drawingStep, 26);
    assert.equal(getFirstDrawingRow(256 / seamOverview.opHeight, seamOverview.drawingStep), 13650);

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

test("Web render metrics reversibly follow the visible phase during vertical scrolling", () => {
    const trace = createLatencyTrace([
        [100, 1000],
        [200, 220],
        [300, 300],
    ]);
    const horizontalAnchorPixel = 160;
    const anchorOffset = horizontalAnchorPixel / KONATA_OP_WIDTH;
    const cases = [
        { cycle: 50, mappedCycle: 150 },
        { cycle: 100, mappedCycle: 200 },
        { cycle: 550, mappedCycle: 210 },
        { cycle: 1000, mappedCycle: 220 },
        { cycle: 1050, mappedCycle: 270 },
    ];

    for (const { cycle, mappedCycle } of cases) {
        const initial = {
            ...DEFAULT_KONATA_RENDER_SPEC,
            position: [cycle - anchorOffset, 0] as const,
        };
        const moved = new KonataRenderMetrics(trace, initial).withLogicalDifference(
            [0, 1],
            true,
            horizontalAnchorPixel,
        );
        assert.ok(Math.abs(moved.position[0] + anchorOffset - mappedCycle) < 1e-9);

        const restored = new KonataRenderMetrics(trace, moved).withLogicalDifference(
            [0, -1],
            true,
            horizontalAnchorPixel,
        );
        assert.ok(Math.abs(restored.position[0] - initial.position[0]) < 1e-9);
        assert.equal(restored.position[1], initial.position[1]);
    }

    // 0-cycle命令にも仮想幅を使い、長latency命令との往復で位置を失わない。
    const initial = {
        ...DEFAULT_KONATA_RENDER_SPEC,
        position: [550 - anchorOffset, 0] as const,
    };
    const zeroCycle = new KonataRenderMetrics(trace, initial).withLogicalDifference(
        [0, 2],
        true,
        horizontalAnchorPixel,
    );
    assert.ok(Math.abs(zeroCycle.position[0] + anchorOffset - 300.5) < 1e-9);
    const restored = new KonataRenderMetrics(trace, zeroCycle).withLogicalDifference(
        [0, -2],
        true,
        horizontalAnchorPixel,
    );
    assert.ok(Math.abs(restored.position[0] - initial.position[0]) < 1e-9);
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
        { ...DEFAULT_KONATA_RENDER_SPEC, zoomLevel: 6, theme: "light" },
        createCanvas(pipeline.context),
        undefined,
        undefined,
        undefined,
        false,
        false,
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
        {
            ...DEFAULT_KONATA_RENDER_SPEC,
            zoomLevel: 1,
            theme: "light",
            textLabelMinimumLaneHeight: 100,
        },
        createCanvas(pipeline.context),
    );

    // 文字を省略した50%描画でも、塗りと同じ矩形へlight themeの1px枠を残す。
    const stageRectIndex = pipeline.fillStyles.indexOf("[object Object]");
    assert.ok(stageRectIndex >= 0);
    assert.deepEqual(pipeline.strokeRects, [pipeline.fillRects[stageRectIndex]]);
    assert.deepEqual(pipeline.strokeStyles, ["#444444"]);
    assert.deepEqual(pipeline.lineWidths, [1]);
    assert.deepEqual(pipeline.fillTexts, []);
});

test("Web renderer uses the contrasting light-theme dependency color", () => {
    const { trace, op: producer } = createTrace();
    producer.prodCycle = 4;
    const consumer = new Op();
    consumer.id = 1;
    consumer.rid = 1;
    consumer.retired = true;
    consumer.fetchedCycle = 3;
    consumer.retiredCycle = 9;
    consumer.consCycle = 6;
    consumer.prods.push(new Dependency(producer.id, 0, 0));
    const store = trace.opStore as ArrayOpStore;
    store.setOp(consumer.id, consumer);
    store.setRetiredOp(consumer.rid, consumer);
    const pipeline = createRecordedContext();

    new KonataRenderer().drawPipelineSpec(
        trace,
        { ...DEFAULT_KONATA_RENDER_SPEC, theme: "light" },
        createCanvas(pipeline.context),
    );

    assert.deepEqual(pipeline.pathStrokeStyles, ["#005fde"]);
    assert.deepEqual(pipeline.pathFillStyles, ["#005fde"]);
    assert.deepEqual(pipeline.pathLineWidths, [1]);
});

test("Canvas backend joins only consecutive touching fills with the same appearance", () => {
    const recorded = createRecordedContext();
    const backend = new CanvasBackend();
    const draw = backend.begin(
        createCanvas(recorded.context),
        recorded.context,
        320,
        96,
        false,
    );

    draw.fillVerticalGradientRect(4, 6, 8, 5, "#112233", "#445566", 0.1, 0.9);
    draw.fillVerticalGradientRect(12, 6, 3, 5, "#112233", "#445566", 0.1, 0.9);
    // 半透明色にも使える一般層なので、重なりはblend回数を保つため結合しない。
    draw.fillVerticalGradientRect(14.5, 6, 3, 5, "#112233", "#445566", 0.1, 0.9);
    // 座標が接してもgradientの形が異なるcommandは独立したままにする。
    draw.fillVerticalGradientRect(17.5, 6, 2, 5, "#112233", "#445566", 0.2, 0.9);
    backend.end();

    assert.deepEqual(recorded.fillRects, [
        [4, 6, 11, 5],
        [14.5, 6, 3, 5],
        [17.5, 6, 2, 5],
    ]);
    assert.deepEqual(recorded.gradients.map((gradient) => gradient.stops), [
        [[0, "#112233"], [1, "#445566"]],
        [[0, "#112233"], [1, "#445566"]],
        [[0, "#112233"], [1, "#445566"]],
    ]);
});

test("Canvas backend batches dependency arrow paths in the Canvas fallback", () => {
    const recorded = createRecordedContext();
    const backend = new CanvasBackend();
    const draw = backend.begin(
        createCanvas(recorded.context),
        recorded.context,
        320,
        96,
        false,
    );
    draw.strokeStyle = "#112233";
    draw.fillStyle = "#445566";
    draw.lineWidth = 2;

    draw.beginPath();
    draw.moveTo(1, 2);
    draw.lineTo(11, 12);
    draw.stroke();
    draw.beginPath();
    draw.moveTo(11, 12);
    draw.lineTo(8, 10);
    draw.lineTo(9, 8);
    draw.fill();

    draw.beginPath();
    draw.moveTo(21, 22);
    draw.bezierCurveTo(17, 22, 17, 32, 31, 32);
    draw.stroke();
    draw.beginPath();
    draw.moveTo(31, 32);
    draw.lineTo(28, 30);
    draw.lineTo(29, 28);
    draw.fill();
    backend.end();

    assert.equal(recorded.commands.filter((command) => command === "stroke").length, 1);
    assert.equal(recorded.commands.filter((command) => command === "fill").length, 1);
    assert.equal(recorded.commands.filter((command) => command === "beginPath").length, 2);
    assert.ok(recorded.commands.includes("moveTo:1,2"));
    assert.ok(recorded.commands.includes("lineTo:11,12"));
    assert.ok(recorded.commands.includes("bezierCurveTo:17,22,17,32,31,32"));
    assert.deepEqual(recorded.pathStrokeStyles, ["#112233"]);
    assert.deepEqual(recorded.pathFillStyles, ["#445566"]);
    assert.deepEqual(recorded.pathLineWidths, [2]);
});

test("View controller publishes targets immediately and keeps intermediate frames private", () => {
    let now = 0;
    let pendingFrame: FrameRequestCallback | null = null;
    const scheduler: KonataAnimationScheduler = {
        now: () => now,
        request: (callback) => {
            pendingFrame = callback;
            return 1;
        },
        cancel: () => {
            pendingFrame = null;
        },
    };
    const frames: Readonly<KonataViewFrame>[] = [];
    const targets: Array<{ readonly position: readonly [number, number]; readonly zoomLevel: number }> = [];
    const controller = new KonataViewController(
        { trace: null, targetSpec: DEFAULT_KONATA_RENDER_SPEC },
        (frame) => frames.push(frame),
        (target) => targets.push(target),
        scheduler,
    );
    const target = {
        position: [20, 10] as const,
        zoomLevel: -1,
    };

    controller.transitionTo(target, undefined, { type: "linear", duration: 100 });

    assert.deepEqual(targets, [{ position: [20, 10], zoomLevel: -1 }]);
    assert.deepEqual(frames.at(-1)?.spec.position, [0, 0]);
    assert.deepEqual(frames.at(-1)?.prefetchSpec?.position, [20, 10]);

    now = 50;
    const middleFrame = pendingFrame;
    pendingFrame = null;
    middleFrame?.(now);
    assert.deepEqual(controller.currentSpec.position, [10, 5]);
    assert.equal(controller.currentSpec.zoomLevel, -0.5);
    // 中間frameを描いても、外側へ新しい状態通知は出さない。
    assert.equal(targets.length, 1);

    now = 100;
    const finalFrame = pendingFrame;
    pendingFrame = null;
    finalFrame?.(now);
    assert.deepEqual(controller.currentSpec, { ...DEFAULT_KONATA_RENDER_SPEC, ...target });
    assert.equal(pendingFrame, null);

    controller.transitionTo(
        { position: [40, 20], zoomLevel: -2 },
        undefined,
        { type: "linear", duration: 100 },
    );
    now = 150;
    const interruptedFrame = pendingFrame;
    pendingFrame = null;
    interruptedFrame?.(now);
    assert.deepEqual(controller.currentSpec.position, [30, 15]);

    // 直接操作は現在frameを起点にし、別の中断操作を挟まず進行中の補間を止める。
    controller.setImmediately({ position: [31, 16], zoomLevel: -1.5 });
    assert.deepEqual(controller.currentSpec.position, [31, 16]);
    assert.equal(pendingFrame, null);
    assert.equal(targets.length, 3);
});
