import assert from "node:assert/strict";
import test from "node:test";

import { Dependency, Lane, Op, ParsedTrace, Stage, StageLevelMap } from "../src/core/model";
import { ArrayOpStore } from "../src/core/op_store";
import { PagedOpStore } from "../src/core/paged_op_store";
import { CanvasBackend } from "../src/core/canvas_backend";
import { getCycleActivity } from "../src/core/cycle_activity_analysis";
import {
    buildCycleNavigatorData,
    getCycleNavigatorActivity,
    getCycleNavigatorTopDown,
    updateCycleNavigatorData,
} from "../src/core/trace_navigator_analysis";
import {
    drawComparisonInstructionNavigator,
    drawComparisonCycleNavigator,
    drawCycleNavigator,
    drawInstructionNavigator,
    getComparisonCycleNavigatorScrollPosition,
    getComparisonCycleNavigatorViewport,
    getCycleNavigatorScrollPosition,
    getCycleNavigatorViewport,
    getInstructionNavigatorPosition,
} from "../src/core/trace_navigator_renderer";
import {
    COMPARISON_COLOR_SCHEME,
    DEFAULT_CUSTOM_COLOR_SCHEME,
    DEFAULT_KONATA_RENDER_SPEC,
    formatCompactOpLabel,
    formatOpLabel,
    formatKonataZoomPercent,
    getFirstDrawingRow,
    getVisibilityLevelForMinimumLaneHeight,
    KONATA_OP_WIDTH,
    KonataRenderMetrics,
    KonataRenderer,
    moveSynchronizedRenderSpecs,
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
    readonly fillAlphas: number[];
    readonly strokeRects: Array<[number, number, number, number]>;
    readonly strokeStyles: string[];
    readonly lineWidths: number[];
    readonly clearRects: Array<[number, number, number, number]>;
    readonly gradients: RecordedGradient[];
    readonly commands: string[];
    readonly pathStrokeStyles: string[];
    readonly pathFillStyles: string[];
    readonly pathFillAlphas: number[];
    readonly pathRects: Array<[number, number, number, number]>;
    readonly pathLineWidths: number[];
    readonly context: CanvasRenderingContext2D;
}

function createRecordedContext(): RecordedContext {
    const fillTexts: Array<[string, number, number]> = [];
    const fillRects: Array<[number, number, number, number]> = [];
    const fillStyles: string[] = [];
    const fillAlphas: number[] = [];
    const strokeRects: Array<[number, number, number, number]> = [];
    const strokeStyles: string[] = [];
    const lineWidths: number[] = [];
    const clearRects: Array<[number, number, number, number]> = [];
    const gradients: RecordedGradient[] = [];
    const commands: string[] = [];
    const pathStrokeStyles: string[] = [];
    const pathFillStyles: string[] = [];
    const pathFillAlphas: number[] = [];
    const pathRects: Array<[number, number, number, number]> = [];
    const pathLineWidths: number[] = [];
    const context = {
        fillStyle: "",
        globalAlpha: 1,
        strokeStyle: "",
        lineWidth: 1,
        font: "",
        setTransform() {},
        fillRect(x: number, y: number, width: number, height: number) {
            commands.push("fillRect");
            fillRects.push([x, y, width, height]);
            fillStyles.push(String(this.fillStyle));
            fillAlphas.push(this.globalAlpha);
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
            pathFillAlphas.push(this.globalAlpha);
        },
        rect(x: number, y: number, width: number, height: number) {
            pathRects.push([x, y, width, height]);
        },
        fillText(text: string, x: number, y: number) {
            commands.push(`text:${text}`);
            fillTexts.push([text, x, y]);
        },
        measureText(text: string) {
            return { width: text.length * 6 };
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
        fillAlphas,
        strokeRects,
        strokeStyles,
        lineWidths,
        clearRects,
        gradients,
        commands,
        pathStrokeStyles,
        pathFillStyles,
        pathFillAlphas,
        pathRects,
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

test("Reference guides retain instruction IDs across hidden rows and lane layouts", () => {
    const trace = createLatencyTrace([[0, 10], [1, 10], [2, 10]]);
    const flushed = trace.getOp(0)!;
    flushed.flush = true;
    const op = trace.getOp(2)!;
    op.rid = 1;
    trace.stageLevelMap.getOrCreateLaneID("0");
    trace.stageLevelMap.getOrCreateLaneID("1");
    const spec = { ...DEFAULT_KONATA_RENDER_SPEC, hideFlushedOps: true };
    // RID 1とID 2が異なるTraceで、取得と描画の双方を検査する。
    trace.getOpFromRID = (rid) => rid === 1 ? op : undefined;
    const metrics = new KonataRenderMetrics(trace, spec);
    const guide = metrics.getReferenceGuideFromPixelPosition(metrics.opWidth * 3.25, metrics.opHeight * 1.5);
    assert.deepEqual(guide, { cycle: 3, opID: 2 });
    assert.equal(metrics.getReferenceGuideFromPixelPosition(0, metrics.opHeight * 20), null);
    assert.equal(metrics.getReferenceGuideFromPixelPosition(-1, metrics.opHeight * 1.5), null);

    for (const hideFlushedOps of [false, true]) {
        for (const splitLanes of [false, true]) {
            for (const fixOpHeight of [false, true]) {
                for (const zoomLevel of [-1, 0, 0.5, 2]) {
                    const current = { ...spec, hideFlushedOps, splitLanes, fixOpHeight, zoomLevel,
                        position: [0.25, 0.125] as const };
                    const currentMetrics = new KonataRenderMetrics(trace, current);
                    const recorded = createRecordedContext();
                    new KonataRenderer().drawReferenceGuideSpec(
                        trace, current, createCanvas(recorded.context, 500, 500), guide,
                    );
                    const expected = [
                        [0, Math.round(((hideFlushedOps ? 1 : 2) - 0.125) * currentMetrics.opHeight),
                            500, 1],
                        [Math.round(2.75 * currentMetrics.opWidth), 0, 1, 500],
                    ];
                    assert.equal(recorded.pathRects.length, expected.length);
                    recorded.pathRects.forEach((rect, index) => rect.forEach((value, axis) => {
                        assert.ok(Math.abs(value - expected[index][axis]) < 1e-10);
                    }));
                    assert.deepEqual(recorded.pathFillAlphas, [0.85]);
                    assert.equal(recorded.commands.filter((command) => command === "fill").length, 1);
                    assert.equal(recorded.context.globalAlpha, 1);
                    const labels = createRecordedContext();
                    new KonataRenderer().drawLabelSpec(
                        trace, current, createCanvas(labels.context, 200, 500), guide,
                    );
                    assert.deepEqual(labels.pathRects, [[0, expected[0][1], 200, 1]]);
                    assert.deepEqual(labels.pathFillAlphas, [0.85]);
                    assert.equal(labels.commands.at(-1), "fill");
                }
            }
        }
    }
    const hidden = createRecordedContext();
    new KonataRenderer().drawReferenceGuideSpec(
        trace, spec, createCanvas(hidden.context), { cycle: 3, opID: 0 },
    );
    assert.deepEqual(hidden.pathRects, [[3 * metrics.opWidth, 0, 1, 96]]);
});

test("Reference guides align both axes to physical pixels at every zoom", () => {
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
    const { trace } = createTrace();
    try {
        for (const ratio of [1, 1.25, 1.5, 2]) {
            Object.defineProperty(globalThis, "window", {
                configurable: true,
                value: { devicePixelRatio: ratio },
            });
            for (const zoomLevel of [-1, 0, 0.5, 4]) {
                const spec = { ...DEFAULT_KONATA_RENDER_SPEC, zoomLevel,
                    position: [0.123, -0.321] as const };
                const recorded = createRecordedContext();
                new KonataRenderer().drawReferenceGuideSpec(
                    trace, spec, createCanvas(recorded.context), { cycle: 2, opID: 0 },
                );
                const [, y, , height] = recorded.pathRects[0];
                const [x, , width] = recorded.pathRects[1];
                const metrics = new KonataRenderMetrics(trace, spec);
                assert.ok(Math.abs(x * ratio - Math.round(1.877 * metrics.opWidth * ratio)) < 1e-10);
                assert.ok(Math.abs(y * ratio - Math.round(0.321 * metrics.opHeight * ratio)) < 1e-10);
                assert.equal(width * ratio, 1);
                assert.equal(height * ratio, 1);
                const labels = createRecordedContext();
                new KonataRenderer().drawLabelSpec(
                    trace, spec, createCanvas(labels.context, 200, 96), { cycle: 2, opID: 0 },
                );
                assert.deepEqual(labels.pathRects, [[0, y, 200, height]]);
            }
        }
    }
    finally {
        if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
        else Reflect.deleteProperty(globalThis, "window");
    }
});

test("Reference guides clip to the viewport and clear without touching pipeline resources", () => {
    const { trace } = createTrace();
    for (const theme of ["dark", "light"] as const) {
        const spec = { ...DEFAULT_KONATA_RENDER_SPEC, theme, position: [2, 0] as const };
        const renderer = new KonataRenderer();
        const recorded = createRecordedContext();
        const canvas = createCanvas(recorded.context);
        renderer.drawReferenceGuideSpec(trace, spec, canvas, { cycle: 1, opID: 0 });
        assert.deepEqual(recorded.pathRects, [[0, 0, 320, 1]]);
        assert.deepEqual(recorded.pathFillAlphas, [0.85]);
        assert.deepEqual(recorded.pathFillStyles, [theme === "light" ? "#20242c" : "#ffffff"]);
        recorded.pathRects.length = 0;
        // 選択行の一部が見えていても、画面外の基準線を端へ吸着させない。
        for (const position of [[2, 0.5], [-20, -20]] as const) {
            renderer.drawReferenceGuideSpec(trace, { ...spec, position }, canvas, { cycle: 1, opID: 0 });
        }
        renderer.drawReferenceGuideSpec(trace, spec, canvas, null);
        renderer.drawReferenceGuideSpec(trace, spec, canvas, { cycle: 2, opID: 999 });
        renderer.drawReferenceGuideSpec(null, spec, canvas, { cycle: 2, opID: 0 });
        assert.deepEqual(recorded.pathRects, []);
        assert.deepEqual(recorded.fillRects, []);
        assert.equal(recorded.clearRects.length, 6);
        assert.equal(recorded.fillTexts.length, 0);
    }
});

test("Reference guides disappear from labels when cleared, offscreen, or hidden", () => {
    const { trace, op } = createTrace();
    op.flush = true;
    for (const [spec, guide] of [
        [DEFAULT_KONATA_RENDER_SPEC, null],
        [DEFAULT_KONATA_RENDER_SPEC, { cycle: 2, opID: 999 }],
        [{ ...DEFAULT_KONATA_RENDER_SPEC, hideFlushedOps: true }, { cycle: 2, opID: 0 }],
        [{ ...DEFAULT_KONATA_RENDER_SPEC, position: [0, 0.5] as const }, { cycle: 2, opID: 0 }],
    ] as const) {
        const recorded = createRecordedContext();
        new KonataRenderer().drawLabelSpec(trace, spec, createCanvas(recorded.context), guide);
        assert.deepEqual(recorded.pathRects, []);
        assert.deepEqual(recorded.fillRects[0], [0, 0, 320, 96]);
    }
});

test("Reference guides locate exact instruction IDs in full-range navigator tracks", () => {
    const store = new ArrayOpStore();
    for (let id = 0; id < 4; id++) {
        const op = new Op();
        op.id = id;
        op.rid = Math.max(0, id - 1);
        op.flush = id === 0;
        op.retired = !op.flush;
        op.fetchedCycle = id;
        op.retiredCycle = id + 4;
        store.setOp(id, op);
        if (!op.flush) store.setRetiredOp(op.rid, op);
    }
    const trace = new ParsedTrace("guides.log", store, new StageLevelMap(), 8);
    for (const theme of ["light", "dark"] as const) {
        for (const hideFlushedOps of [false, true]) {
            for (const zoomLevel of [-1, 0, 2]) {
                // Pipelineでは画面外でも、navigator上の位置はpan／zoomに影響されない。
                const spec = { ...DEFAULT_KONATA_RENDER_SPEC, theme, hideFlushedOps, zoomLevel,
                    position: [100, 20] as const };
                const source = { trace, spec };
                for (const mode of ["baseline", "candidate", "overlay"] as const) {
                    const recorded = createRecordedContext();
                    drawComparisonInstructionNavigator(
                        { baseline: { trace: createTrace().trace, spec }, candidate: source },
                        createCanvas(recorded.context, 100, 96), mode, 48,
                        { cycle: 3, opID: mode === "baseline" ? 0 : 2 },
                    );
                    const y = mode === "baseline" ? 0 : hideFlushedOps ? 32 : 48;
                    assert.deepEqual(recorded.pathRects, [[mode === "overlay" ? 50 : 0, y,
                        mode === "overlay" ? 50 : 100, 1]]);
                    assert.deepEqual(recorded.pathFillAlphas, [0.85]);
                    assert.deepEqual(recorded.pathFillStyles, [theme === "light" ? "#20242c" : "#ffffff"]);
                    assert.equal(recorded.commands.at(-1), "fill");
                }
            }
        }
    }
    for (const guide of [null, { cycle: 3, opID: 0 }, { cycle: 3, opID: 999 }]) {
        const recorded = createRecordedContext();
        drawInstructionNavigator(trace, { ...DEFAULT_KONATA_RENDER_SPEC, hideFlushedOps: true },
            createCanvas(recorded.context, 100, 96), 48, guide);
        assert.deepEqual(recorded.pathRects, []);
        assert.deepEqual(recorded.fillRects[0], [0, 0, 100, 96]);
    }
});

test("Reference guides use navigator cycle scales and stay inside the selected track", async () => {
    const data = await buildCycleNavigatorData(createTrace().trace);
    assert.ok(data !== null);
    const baseline = { data: { ...data, cycleCount: 100 },
        spec: { ...DEFAULT_KONATA_RENDER_SPEC, position: [1, 0] as const } };
    const candidate = { data: { ...data, cycleCount: 200 },
        spec: { ...DEFAULT_KONATA_RENDER_SPEC, position: [2, 0] as const } };
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
    try {
        for (const ratio of [1, 1.25, 1.5, 2]) {
            Object.defineProperty(globalThis, "window", {
                configurable: true, value: { devicePixelRatio: ratio },
            });
            for (const mode of ["baseline", "candidate", "overlay"] as const) {
                for (const range of ["follow", "overview"] as const) {
                    const recorded = createRecordedContext();
                    const labels = createRecordedContext();
                    drawComparisonCycleNavigator({ baseline, candidate }, createCanvas(labels.context),
                        createCanvas(recorded.context, 200, 80), mode, "fetch", false, range,
                        { cycle: 3, opID: 0 });
                    const x = range === "follow" ? (mode === "baseline" ? 64 : 32)
                        : mode === "baseline" ? 6 : 3;
                    assert.deepEqual(recorded.pathRects, [[Math.round(x * ratio) / ratio,
                        mode === "overlay" ? 40 : 0, 1 / ratio, mode === "overlay" ? 40 : 80]]);
                    assert.deepEqual(recorded.pathFillAlphas, [0.85]);
                    assert.equal(recorded.commands.at(-1), "fill");
                    assert.deepEqual(labels.pathRects, []);
                }
            }
            const last = createRecordedContext();
            drawCycleNavigator({ ...data, cycleCount: 10000 }, candidate.spec,
                createCanvas(createRecordedContext().context), createCanvas(last.context, 200, 80),
                "fetch", false, "overview", { cycle: 9999, opID: 0 });
            assert.deepEqual(last.pathRects, [[200 - 1 / ratio, 0, 1 / ratio, 80]]);
            for (const guide of [null, { cycle: 1, opID: 0 }, { cycle: 10000, opID: 0 }]) {
                const recorded = createRecordedContext();
                drawCycleNavigator(data, candidate.spec, createCanvas(createRecordedContext().context),
                    createCanvas(recorded.context, 200, 80), "fetch", false, "follow", guide);
                assert.deepEqual(recorded.pathRects, []);
                assert.deepEqual(recorded.fillRects[0], [0, 0, 200, 80]);
            }
        }
    }
    finally {
        if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
        else Reflect.deleteProperty(globalThis, "window");
    }
});

function createTopDownCancellationTrace(cycleCount = 8): ParsedTrace {
    const store = new ArrayOpStore();
    const levelMap = new StageLevelMap();
    const laneID = levelMap.getOrCreateLaneID("0");
    const addOp = (id: number, startCycle: number, endCycle: number, flush: boolean) => {
        const op = new Op();
        op.id = id;
        op.rid = id;
        op.retired = !flush;
        op.flush = flush;
        op.fetchedCycle = startCycle;
        op.retiredCycle = endCycle;
        const lane = new Lane();
        const stage = new Stage();
        stage.name = "X";
        stage.startCycle = startCycle;
        stage.endCycle = endCycle;
        lane.stages.push(stage);
        op.lanes[laneID] = lane;
        levelMap.update("0", stage.name, lane);
        store.setOp(id, op);
        if (!flush) {
            store.setRetiredOp(op.rid, op);
        }
    };
    addOp(0, 0, 4, false);
    addOp(1, 2, 6, true);
    return new ParsedTrace("activity.log", store, levelMap, cycleCount);
}

function createTopDownBreakdownTrace(): ParsedTrace {
    const store = new ArrayOpStore();
    const levelMap = new StageLevelMap();
    const laneID = levelMap.getOrCreateLaneID("0");
    const timings = [
        // The oldest retired op leaves the reservoir after the younger retired op. This
        // makes the otherwise arbitrary reservoir an observable allocation queue.
        { source: 2, allocation: 3, execution: 11, retiredCycle: 13 },
        { source: 2, allocation: 3, execution: 5, retiredCycle: 6 },
        // execution待ちの命令がbackend内に残っていても、allocationを妨げていなければ
        // TMA Level 1では空きslotをBackendへ分類しない。
        { source: 3, allocation: 4, execution: 9, retiredCycle: 10 },
        { source: 8, allocation: 9, execution: 10, retiredCycle: 11 },
    ] as const;
    timings.forEach((timing, id) => {
        const op = new Op();
        op.id = id;
        op.gid = id;
        op.rid = id;
        op.tid = 0;
        op.retired = id === 0 || id === 3;
        op.flush = id === 1;
        op.fetchedCycle = timing.source;
        op.retiredCycle = timing.retiredCycle;
        const lane = new Lane();
        const ranges = [
            ["arbitrary-source", timing.source, timing.allocation],
            ["arbitrary-reservoir", timing.allocation, timing.execution],
            ["arbitrary-event", timing.execution, timing.execution + 1],
            ["arbitrary-tail", timing.execution + 1, timing.retiredCycle],
        ] as const;
        for (const [name, startCycle, endCycle] of ranges) {
            const stage = new Stage();
            stage.name = name;
            stage.startCycle = startCycle;
            stage.endCycle = endCycle;
            lane.stages.push(stage);
            levelMap.update("0", name, lane);
        }
        op.lanes[laneID] = lane;
        store.setOp(id, op);
        if (op.retired) {
            store.setRetiredOp(op.rid, op);
        }
    });
    return new ParsedTrace("topdown.log", store, levelMap, 14);
}

function createCompositeAllocationTrace(): ParsedTrace {
    const store = new ArrayOpStore();
    const levelMap = new StageLevelMap();
    const pipelineLaneID = levelMap.getOrCreateLaneID("0");
    const stallLaneID = levelMap.getOrCreateLaneID("1");
    const timings = [
        { stage: "ready", start: 2, end: 8, stallEnd: 12 },
        { stage: "wait", start: 2, end: 9, stallEnd: 11 },
        { stage: "ready", start: 2, end: 6, stallEnd: 10 },
        { stage: "wait", start: 3, end: 7, stallEnd: 9 },
    ] as const;
    timings.forEach((timing, id) => {
        const op = new Op();
        op.id = id;
        op.gid = id;
        op.rid = id;
        op.tid = 0;
        op.retired = true;
        op.fetchedCycle = timing.start - 1;
        op.retiredCycle = timing.end + 2;
        const lane = new Lane();
        const execution = timing.stage === "ready" ? "execute-ready" : "execute-wait";
        for (const [name, startCycle, endCycle] of [
            ["source", timing.start - 1, timing.start],
            [timing.stage, timing.start, timing.end],
            [execution, timing.end, timing.end + 1],
            ["complete", timing.end + 1, timing.end + 2],
        ] as const) {
            const stage = new Stage();
            stage.name = name;
            stage.startCycle = startCycle;
            stage.endCycle = endCycle;
            lane.stages.push(stage);
            levelMap.update("0", name, lane);
        }
        op.lanes[pipelineLaneID] = lane;
        const stallLane = new Lane();
        const stall = new Stage();
        stall.name = "stall";
        stall.startCycle = 1;
        stall.endCycle = timing.stallEnd;
        stallLane.stages.push(stall);
        levelMap.update("1", stall.name, stallLane);
        op.lanes[stallLaneID] = stallLane;
        store.setOp(id, op);
        store.setRetiredOp(id, op);
    });
    return new ParsedTrace("composite-allocation.log", store, levelMap, 14);
}

function appendTopDownBreakdownOp(
    trace: ParsedTrace,
    id: number,
    ranges: readonly (readonly [string, number, number])[],
): void {
    const laneID = trace.stageLevelMap.getLaneID("0");
    assert.ok(laneID !== undefined);
    const op = new Op();
    op.id = id;
    op.gid = id;
    op.rid = id;
    op.tid = 0;
    op.retired = true;
    op.fetchedCycle = ranges[0]?.[1] ?? 0;
    op.retiredCycle = ranges.at(-1)?.[2] ?? op.fetchedCycle;
    const lane = new Lane();
    for (const [name, startCycle, endCycle] of ranges) {
        const stage = new Stage();
        stage.name = name;
        stage.startCycle = startCycle;
        stage.endCycle = endCycle;
        lane.stages.push(stage);
        trace.stageLevelMap.update("0", name, lane);
    }
    op.lanes[laneID] = lane;
    const store = trace.opStore as ArrayOpStore;
    store.setOp(id, op);
    store.setRetiredOp(op.rid, op);
    trace.updateLastCycle(Math.max(trace.lastCycle, op.retiredCycle));
}

function createCycleActivityTrace(): ParsedTrace {
    const trace = createTopDownBreakdownTrace();
    // 追加命令のIssue→Completion latencyを4 cycleとして観測する。
    appendTopDownBreakdownOp(trace, 4, [
        ["arbitrary-source", 10, 11],
        ["arbitrary-reservoir", 11, 12],
        ["arbitrary-event", 12, 16],
        ["arbitrary-tail", 16, 17],
    ]);
    trace.updateLastCycle(18);
    return trace;
}

function createAllocationBlockedTrace(): ParsedTrace {
    const store = new ArrayOpStore();
    const levelMap = new StageLevelMap();
    const laneID = levelMap.getOrCreateLaneID("0");
    const rangesByOp = [
        [["entry-a", 3, 4], ["allocation", 4, 11], ["execution", 11, 12], ["tail", 12, 13]],
        [["entry-b", 3, 4], ["allocation", 4, 9], ["execution", 9, 10], ["tail", 10, 11]],
        [["entry-c", 3, 4], ["allocation", 4, 7], ["execution", 7, 8], ["tail", 8, 9]],
        [["entry-d", 3, 4], ["allocation", 4, 5], ["execution", 5, 6], ["tail", 6, 7]],
        // 最初の4命令は同時にallocateされた後、直列にexecutionへ進む。5番目だけは
        // 通常1 cycleのentry-aを7 cycle占有し、backend入口で止められる。
        [["entry-a", 5, 12], ["allocation", 12, 13], ["execution", 13, 14], ["tail", 14, 15]],
    ] as const;
    rangesByOp.forEach((ranges, id) => {
        const op = new Op();
        op.id = id;
        op.gid = id;
        op.rid = id;
        op.tid = 0;
        op.retired = true;
        op.fetchedCycle = ranges[0][1];
        op.retiredCycle = ranges[ranges.length - 1][2];
        const lane = new Lane();
        for (const [name, startCycle, endCycle] of ranges) {
            const stage = new Stage();
            stage.name = name;
            stage.startCycle = startCycle;
            stage.endCycle = endCycle;
            lane.stages.push(stage);
            levelMap.update("0", name, lane);
        }
        op.lanes[laneID] = lane;
        store.setOp(id, op);
        store.setRetiredOp(id, op);
    });
    return new ParsedTrace("allocation-blocked.log", store, levelMap, 16);
}

function createRecoveryBubbleTrace(
    recoveryLatencies: readonly number[],
    firstWindowHasAllocationBackpressure = false,
): ParsedTrace {
    const store = new ArrayOpStore();
    const levelMap = new StageLevelMap();
    const laneID = levelMap.getOrCreateLaneID("0");
    let id = 0;
    let lastEndCycle = 0;
    const addOp = (
        retired: boolean,
        flush: boolean,
        labelName: string,
        ranges: readonly (readonly [string, number, number])[],
    ) => {
        const op = new Op();
        op.id = id;
        op.gid = id;
        op.rid = id;
        op.tid = 0;
        op.retired = retired;
        op.flush = flush;
        op.labelName = labelName;
        op.fetchedCycle = ranges[0][1];
        op.retiredCycle = ranges[ranges.length - 1][2];
        lastEndCycle = Math.max(lastEndCycle, op.retiredCycle);
        const lane = new Lane();
        for (const [name, startCycle, endCycle] of ranges) {
            const stage = new Stage();
            stage.name = name;
            stage.startCycle = startCycle;
            stage.endCycle = endCycle;
            lane.stages.push(stage);
            levelMap.update("0", name, lane);
        }
        op.lanes[laneID] = lane;
        store.setOp(id, op);
        if (retired) {
            store.setRetiredOp(op.rid, op);
        }
        id++;
    };

    recoveryLatencies.forEach((recoveryLatency, eventIndex) => {
        const base = 10 + eventIndex * 50;
        const causeLabel = eventIndex === 0
            ? "0x00001000: c_bnez a0, target:IntAlu"
            : eventIndex === 1
                ? "0x00401000: JNZ_I : wrip t1, t2:IntAlu"
                : eventIndex === 2
                    ? "0x00001000: cbnz x0, target:IntAlu"
                    : "bne x1, x2, target";
        // stage名は意図的に一般名にする。retired control-flowの直後にflush列があり、
        // その後の最初のretired命令をcorrect pathの再allocationとして観測する。
        addOp(true, false, causeLabel, [
            ["arbitrary-source", base, base + 1],
            ["arbitrary-reservoir", base + 1, base + 4],
            ["arbitrary-event", base + 4, base + 5],
            ["arbitrary-complete", base + 5, base + 6],
            ["arbitrary-tail", base + 6, base + 7],
        ]);
        const wrongPathSourceEnd = eventIndex === 0 && firstWindowHasAllocationBackpressure
            ? base + 4
            : base + 2;
        addOp(false, true, "add x3, x4, x5", [
            ["arbitrary-source", base + 1, wrongPathSourceEnd],
            ["arbitrary-reservoir", wrongPathSourceEnd, base + 4],
            ["arbitrary-event", base + 4, base + 5],
            ["arbitrary-complete", base + 5, base + 6],
            ["arbitrary-tail", base + 6, base + 7],
        ]);
        const correctAllocation = base + 5 + recoveryLatency;
        addOp(true, false, "add x6, x7, x8", [
            ["arbitrary-source", correctAllocation - 1, correctAllocation],
            ["arbitrary-reservoir", correctAllocation, correctAllocation + 2],
            ["arbitrary-event", correctAllocation + 2, correctAllocation + 3],
            ["arbitrary-complete", correctAllocation + 3, correctAllocation + 4],
            ["arbitrary-tail", correctAllocation + 4, correctAllocation + 5],
        ]);
    });
    if (recoveryLatencies.length > 0) {
        // Add a small, causally neutral out-of-order completion after the measured windows so
        // the generic detector can identify the allocation queue from order alone.
        const evidence = lastEndCycle + 2;
        addOp(true, false, "add x9, x10, x11", [
            ["arbitrary-source", evidence - 1, evidence],
            ["arbitrary-reservoir", evidence, evidence + 6],
            ["arbitrary-event", evidence + 6, evidence + 7],
            ["arbitrary-complete", evidence + 7, evidence + 8],
            ["arbitrary-tail", evidence + 8, evidence + 9],
        ]);
        addOp(true, false, "add x12, x13, x14", [
            ["arbitrary-source", evidence, evidence + 1],
            ["arbitrary-reservoir", evidence + 1, evidence + 3],
            ["arbitrary-event", evidence + 3, evidence + 4],
            ["arbitrary-complete", evidence + 4, evidence + 5],
            ["arbitrary-tail", evidence + 5, evidence + 6],
        ]);
    }
    return new ParsedTrace(
        "recovery-bubble.log",
        store,
        levelMap,
        Math.max(1, lastEndCycle + 1),
    );
}

test("Top-down-like view classifies allocation slots without stage names", async () => {
    const trace = createTopDownBreakdownTrace();
    const activity = await buildCycleNavigatorData(trace, { binCycleCount: 1 });
    assert.ok(activity !== null);
    const analysis = activity.topDown;
    assert.ok(analysis !== null);
    assert.equal(analysis.allocationStage.stageName, "arbitrary-reservoir");
    assert.equal(analysis.executionStage.stageName, "arbitrary-event");
    assert.equal(analysis.allocationWidth, 2);
    assert.ok(analysis.slotCounts instanceof Uint16Array);
    assert.equal(analysis.slotCounts.length, activity.cycleCount * 6);
    assert.equal(analysis.transitionCoverage, 1);
    assert.equal(analysis.admissionStages.length, 1);
    assert.equal(analysis.admissionStages[0].stage.stageName, "arbitrary-source");
    assert.equal(analysis.admissionStages[0].typicalLatency, 1);

    const fullAllocation = getCycleNavigatorTopDown(activity, 3, 4);
    assert.ok(fullAllocation !== null);
    assert.equal(fullAllocation.totalSlots, 2);
    assert.equal(fullAllocation.retiringSlots, 1);
    assert.equal(fullAllocation.squashedSlots, 1);
    assert.equal(fullAllocation.unresolvedSlots, 0);
    assert.equal(fullAllocation.frontendBound, 0);
    assert.equal(fullAllocation.backendBound, 0);
    const overviewSpec = { ...DEFAULT_KONATA_RENDER_SPEC, position: [3, 0] } as const;
    const overviewWidth = 320;
    const viewport = getCycleNavigatorViewport(activity.cycleCount, overviewSpec, overviewWidth);
    assert.ok(viewport !== null && viewport.width < overviewWidth);
    assert.ok(Math.abs((getCycleNavigatorScrollPosition(
        activity.cycleCount,
        overviewSpec,
        overviewWidth,
        viewport.left,
    ) ?? -1) - 3) < 0.001);
    const baselineSpec = { ...overviewSpec, position: [2, 0] } as const;
    const comparison = {
        baseline: { data: activity, spec: baselineSpec },
        candidate: { data: activity, spec: overviewSpec },
    } as const;
    const baselineViewport = getComparisonCycleNavigatorViewport(
        comparison,
        "overlay",
        "baseline",
        overviewWidth,
    );
    const candidateViewport = getComparisonCycleNavigatorViewport(
        comparison,
        "overlay",
        "candidate",
        overviewWidth,
    );
    assert.ok(baselineViewport !== null && baselineViewport.width < overviewWidth);
    assert.ok(candidateViewport !== null && candidateViewport.width < overviewWidth);
    assert.ok(baselineViewport.left < candidateViewport.left);
    const baselinePosition = getComparisonCycleNavigatorScrollPosition(
        comparison,
        "overlay",
        "baseline",
        overviewWidth,
        baselineViewport.left,
    );
    assert.ok(baselinePosition !== null);
    assert.ok(Math.abs(baselinePosition - 2) < 0.001);
    const candidatePosition = getComparisonCycleNavigatorScrollPosition(
        comparison,
        "overlay",
        "candidate",
        overviewWidth,
        candidateViewport.left,
    );
    assert.ok(candidatePosition !== null);
    assert.ok(Math.abs(candidatePosition - 3) < 0.001);

    // 全長・zoom・位置が異なるA/Bでも、描画とdragが同じ軸を使う。
    const unequalComparison = {
        baseline: { data: { ...activity, cycleCount: 1000 }, spec: { ...baselineSpec, zoomLevel: -2 } },
        candidate: { data: { ...activity, cycleCount: 100 }, spec: overviewSpec },
    };
    for (const mode of ["baseline", "candidate", "overlay"] as const) {
        for (const track of ["baseline", "candidate"] as const) {
            const source = unequalComparison[mode === "overlay" ? track : mode];
            const count = mode === "overlay" ? 1000 : source.data.cycleCount;
            const viewport = getComparisonCycleNavigatorViewport(unequalComparison, mode, track, overviewWidth);
            assert.deepEqual(viewport, getCycleNavigatorViewport(count, source.spec, overviewWidth));
            assert.ok(viewport !== null);
            assert.ok(Math.abs((getComparisonCycleNavigatorScrollPosition(
                unequalComparison, mode, track, overviewWidth, viewport.left,
            ) ?? -1) - source.spec.position[0]) < 0.001);
        }
    }

    const partialAllocation = getCycleNavigatorTopDown(activity, 4, 5);
    assert.ok(partialAllocation !== null);
    assert.equal(partialAllocation.totalSlots, 2);
    assert.equal(partialAllocation.retiringSlots, 0);
    assert.equal(partialAllocation.squashedSlots, 0);
    assert.equal(partialAllocation.unresolvedSlots, 1);
    // execution待ちの命令が残っていても、allocation入口が詰まっていなければFrontend。
    assert.equal(partialAllocation.frontendBound, 1);
    assert.equal(partialAllocation.backendBound, 0);

    const postSquashGap = getCycleNavigatorTopDown(activity, 6, 7);
    assert.ok(postSquashGap !== null);
    assert.equal(postSquashGap.totalSlots, 2);
    // squash後の空白だけからrecoveryを推定せず、入口backpressureがなければFrontend。
    assert.equal(postSquashGap.squashedSlots, 0);
    assert.equal(postSquashGap.frontendBound, 2);
    assert.equal(postSquashGap.backendBound, 0);

    const frontend = getCycleNavigatorTopDown(activity, 9, 10);
    assert.ok(frontend !== null);
    assert.equal(frontend.totalSlots, 2);
    assert.equal(frontend.retiringSlots, 1);
    assert.equal(frontend.frontendBound, 1);
    assert.equal(frontend.backendBound, 0);

    const labels = createRecordedContext();
    const cycleNavigator = createRecordedContext();
    drawCycleNavigator(
        activity,
        { ...DEFAULT_KONATA_RENDER_SPEC, position: [3, 0] },
        createCanvas(labels.context, 450, 128),
        createCanvas(cycleNavigator.context, 320, 128),
        "top-down",
        true,
    );
    assert.ok(labels.fillTexts.some(([text, x, y]) =>
        text === "AUTO · arbitrary-reservoir ≥2/c → arbitrary-event" &&
        x === 128 && y === 16));
    const legendNames = new Set(["Bad spec", "Front", "Back", "Pending", "Retire"]);
    assert.deepEqual(
        labels.fillTexts.map(([text]) => text).filter((text) => legendNames.has(text)),
        ["Bad spec", "Front", "Back", "Retire"],
    );
    const legendRects = labels.fillRects.filter(([, , width, height]) =>
        width === 10 && height === 10);
    assert.equal(legendRects.length, 4);
    assert.deepEqual(legendRects.map(([x, y]) => [x, y]), [
        [381, 7],
        [381, 21],
        [381, 35],
        [381, 49],
    ]);
    assert.equal(labels.strokeRects.length, 0);
    const compactLabels = createRecordedContext();
    drawCycleNavigator(
        activity,
        { ...DEFAULT_KONATA_RENDER_SPEC, position: [3, 0] },
        createCanvas(compactLabels.context, 450, 128),
        createCanvas(createRecordedContext().context, 320, 128),
    );
    assert.ok(!compactLabels.fillTexts.some(([text]) => text.startsWith("AUTO")));
    assert.ok(!compactLabels.fillTexts.some(([text]) =>
        text === "arbitrary-reservoir ≥2/c → arbitrary-event"));
    assert.ok(compactLabels.fillTexts.some(([text]) => text === "Retire"));
    assert.ok(cycleNavigator.fillRects.length > 0);
    for (const color of [
        "hsl(0,0%,55%)",
        "hsl(240,35%,55%)",
        "hsl(140,35%,55%)",
        "#262930",
    ]) {
        assert.ok(cycleNavigator.fillStyles.includes(color));
    }
    const colorsAtX = (x: number) => cycleNavigator.fillRects
        .map((rect, index) => ({ rect, color: cycleNavigator.fillStyles[index] }))
        .filter(({ rect }) => rect[0] === x && rect[2] < 320)
        .map(({ color }) => color);
    assert.deepEqual(colorsAtX(0), ["hsl(0,0%,55%)", "hsl(140,35%,55%)"]);
    assert.deepEqual(colorsAtX(32), ["hsl(240,35%,55%)", "#262930"]);

    const overviewNavigator = createRecordedContext();
    drawCycleNavigator(
        activity,
        overviewSpec,
        createCanvas(createRecordedContext().context, 450, 128),
        createCanvas(overviewNavigator.context, overviewWidth, 128),
        "top-down",
        false,
        "overview",
    );
    assert.equal(overviewNavigator.strokeRects.length, 1);
    assert.equal(overviewNavigator.strokeStyles[0], "rgba(255,255,255,0.75)");
    assert.ok(overviewNavigator.fillStyles.includes("rgba(0,0,0,0.35)"));

    const lightNavigator = createRecordedContext();
    drawCycleNavigator(
        activity,
        { ...DEFAULT_KONATA_RENDER_SPEC, position: [3, 0], theme: "light" },
        createCanvas(createRecordedContext().context, 450, 128),
        createCanvas(lightNavigator.context, 320, 128),
        "top-down",
        false,
        "overview",
    );
    for (const color of [
        "hsl(0,0%,73%)",
        "hsl(240,53%,73%)",
        "hsl(140,53%,73%)",
        "#ffffff",
    ]) {
        assert.ok(lightNavigator.fillStyles.includes(color));
    }
    assert.equal(lightNavigator.strokeStyles[0], "rgba(0,0,0,0.55)");
    assert.ok(lightNavigator.fillStyles.includes("rgba(255,255,255,0.25)"));

    const comparisonNavigator = createRecordedContext();
    drawComparisonCycleNavigator(
        comparison,
        createCanvas(createRecordedContext().context, 450, 128),
        createCanvas(comparisonNavigator.context, overviewWidth, 128),
        "overlay",
        "top-down",
        false,
        "overview",
    );
    assert.ok(comparisonNavigator.fillTexts.some(([text, x, y]) =>
        text === "A" && x === 4 && y === 32));
    assert.ok(comparisonNavigator.fillTexts.some(([text, x, y]) =>
        text === "B" && x === 4 && y === 96));
    assert.ok(comparisonNavigator.fillRects.some(([x, y, width, height]) =>
        x === 0 && y === 64 && width === overviewWidth && height === 1));
    assert.equal(comparisonNavigator.strokeRects.length, 2);
    trace.close();
});

test("Instruction navigator draws one wrapped lifetime per sampled instruction", () => {
    const trace = createTopDownBreakdownTrace();
    const height = 48;
    const baselineSpec = {
        ...DEFAULT_KONATA_RENDER_SPEC,
        position: [2, 0],
    } as const;
    const candidateSpec = {
        ...DEFAULT_KONATA_RENDER_SPEC,
        position: [3, 1],
    } as const;
    const position = getInstructionNavigatorPosition(
        trace, candidateSpec, height, 1,
    );
    assert.ok(position !== null && position[0] >= 0 && position[1] >= 0);

    const navigator = createRecordedContext();
    drawInstructionNavigator(
        trace,
        candidateSpec,
        createCanvas(navigator.context, 16, height),
        160,
    );
    assert.ok(navigator.fillStyles.includes("hsl(0,0%,70%)"));
    assert.ok(navigator.fillStyles.includes("hsl(0,0%,55%)"));
    assert.ok(navigator.fillStyles.includes("rgba(0,0,0,0.6)"));
    assert.ok(navigator.fillStyles.includes("rgba(255,255,255,0.75)"));

    const lightNavigator = createRecordedContext();
    drawInstructionNavigator(
        trace,
        { ...candidateSpec, theme: "light" },
        createCanvas(lightNavigator.context, 16, height),
        160,
    );
    assert.ok(lightNavigator.fillStyles.includes("rgba(0,0,0,0.68)"));
    assert.ok(lightNavigator.fillStyles.includes("rgba(0,0,0,0.35)"));
    assert.ok(lightNavigator.fillStyles.includes("rgba(255,255,255,0.6)"));

    const comparison = {
        baseline: { trace, spec: baselineSpec },
        candidate: { trace, spec: candidateSpec },
    } as const;
    const comparisonNavigator = createRecordedContext();
    drawComparisonInstructionNavigator(
        comparison,
        createCanvas(comparisonNavigator.context, 16, height),
        "overlay",
        160,
    );
    assert.ok(comparisonNavigator.fillRects.some(([x, y, width, drawnHeight]) =>
        x === 8 && y === 0 && width === 1 && drawnHeight === height));
    trace.close();
});

test("Instruction navigator magnifies and wraps instruction lifetimes", () => {
    const trace = createLatencyTrace([[14, 15]]);
    const navigator = createRecordedContext();
    const scale = drawInstructionNavigator(
        trace,
        DEFAULT_KONATA_RENDER_SPEC,
        createCanvas(navigator.context, 16, 3),
        128,
    );
    assert.equal(scale, 1);
    const instructionColor = "hsl(0,0%,70%)";
    assert.ok(navigator.fillRects.some((rect, index) =>
        navigator.fillStyles[index] === instructionColor &&
        rect[0] === 14 && rect[1] === 0 && rect[2] === 2 && rect[3] === 3));
    assert.ok(navigator.fillRects.some((rect, index) =>
        navigator.fillStyles[index] === instructionColor &&
        rect[0] === 0 && rect[1] === 0 && rect[2] === 6 && rect[3] === 3));
    assert.ok(navigator.fillRects.some((rect, index) =>
        navigator.fillStyles[index] === "hsl(0,0%,84%)" &&
        rect[0] === 14 && rect[1] === 0 && rect[2] === 1 && rect[3] === 3));
    assert.ok(navigator.fillRects.some((rect, index) =>
        navigator.fillStyles[index] === "hsl(0,0%,84%)" &&
        rect[0] === 5 && rect[1] === 0 && rect[2] === 1 && rect[3] === 3));
    assert.deepEqual(
        getInstructionNavigatorPosition(
            trace, DEFAULT_KONATA_RENDER_SPEC, 3, 1,
        ),
        [14, 0],
    );
    trace.close();

    const flushedTrace = createTopDownCancellationTrace();
    const flushedNavigator = createRecordedContext();
    drawInstructionNavigator(
        flushedTrace,
        DEFAULT_KONATA_RENDER_SPEC,
        createCanvas(flushedNavigator.context, 8, 2),
        128,
    );
    assert.ok(flushedNavigator.fillRects.some((rect, index) =>
        flushedNavigator.fillStyles[index] === "hsl(0,0%,55%)" &&
        rect[0] === 0 && rect[1] === 1 && rect[2] === 8 && rect[3] === 1));
    flushedTrace.close();

    const pipelineAspectTrace = createLatencyTrace(Array.from(
        { length: 64 },
        (_, id) => [Math.floor(id / 4), Math.floor(id / 4) + 16] as const,
    ));
    const aspectNavigator = createRecordedContext();
    assert.equal(drawInstructionNavigator(
        pipelineAspectTrace,
        DEFAULT_KONATA_RENDER_SPEC,
        createCanvas(aspectNavigator.context, 16, 4),
        128,
    ), 12);
    assert.deepEqual(aspectNavigator.fillRects
        .filter((_, index) => aspectNavigator.fillStyles[index] === instructionColor)
        .map(([x, y, width]) => [x, y, width]), [
            [0, 0, 11], [0, 1, 11], [0, 2, 11], [1, 3, 11],
        ]);
    for (let y = 0; y < 4; y++) {
        assert.deepEqual(getInstructionNavigatorPosition(
            pipelineAspectTrace, DEFAULT_KONATA_RENDER_SPEC, 4, y,
        ), [y * 4 + 2, y * 16 + 8]);
    }
    pipelineAspectTrace.close();
});

test("Instruction navigator hit testing follows drawn row boundaries", () => {
    for (const [rowCount, height] of [[3, 4], [5, 8], [7, 11], [100, 200]]) {
        const trace = createLatencyTrace(Array.from(
            { length: rowCount }, (_, id) => [id * 8, id * 8 + 1] as const,
        ));
        const navigator = createRecordedContext();
        const width = rowCount * 8;
        drawInstructionNavigator(
            trace, DEFAULT_KONATA_RENDER_SPEC,
            createCanvas(navigator.context, width, height), 1,
        );
        const bars = navigator.fillRects.filter((_, index) =>
            navigator.fillStyles[index] === "hsl(0,0%,70%)");
        assert.equal(bars.length, rowCount);
        for (const [x, top, , barHeight] of bars) {
            for (let y = top; y < top + barHeight; y++) {
                assert.deepEqual(getInstructionNavigatorPosition(
                    trace, DEFAULT_KONATA_RENDER_SPEC, height, y,
                ), [x, x / 8], `Row ${y} of ${height} pixels / ${rowCount} ops`);
            }
        }
        trace.close();
    }
});

test("Instruction navigator restores the selected fetch cycle from any view", () => {
    const trace = createLatencyTrace([[100, 1000], [200, 220], [300, 300]]);
    for (const hideFlushedOps of [false, true]) {
        const spec = {
            ...DEFAULT_KONATA_RENDER_SPEC,
            position: [900, -10] as const,
            zoomLevel: 8,
            hideFlushedOps,
        };
        for (const [y, cycle, row] of [
            [-10, 100, 0], [0, 100, 0], [10, 200, 1], [29, 300, 2], [50, 300, 2],
        ]) {
            assert.deepEqual(getInstructionNavigatorPosition(trace, spec, 30, y), [cycle, row]);
        }
        assert.equal(getInstructionNavigatorPosition(trace, spec, 0, 0), null);
    }
    trace.close();
});

test("Instruction navigator draws and selects coarse-page samples without decoding full pages", async () => {
    const store = new PagedOpStore({ maxCachedOps: 1, maxDecodedPages: 1 });
    for (let id = 0; id < 1024; id++) {
        const op = new Op();
        op.id = id;
        op.rid = Math.floor(id / 2);
        op.flush = id % 2 !== 0;
        op.retired = !op.flush;
        op.fetchedCycle = id;
        op.retiredCycle = id + 1;
        store.setOp(id, op);
        if (op.retired) store.setRetiredOp(op.rid, op);
    }
    await store.waitForPendingCompression();
    const trace = new ParsedTrace("coarse.log", store, new StageLevelMap(), 1024);
    for (const [hideFlushedOps, height] of [[false, 128], [true, 128], [false, 768]] as const) {
        const spec = { ...DEFAULT_KONATA_RENDER_SPEC, hideFlushedOps };
        const before = store.levelMetrics[0];
        const navigator = createRecordedContext();
        drawInstructionNavigator(trace, spec, createCanvas(navigator.context, 32, height), 400);
        assert.equal(navigator.fillStyles.filter(color => color === "hsl(0,0%,70%)").length, height);
        for (let y = 0; y < height; y++) {
            const position = getInstructionNavigatorPosition(trace, spec, height, y);
            assert.ok(position !== null);
            assert.equal(position[0] % 8, 0);
            assert.equal(position[1], position[0] / (hideFlushedOps ? 2 : 1));
            const rowsPerPixel = (hideFlushedOps ? 512 : 1024) / height;
            assert.ok(Math.abs(position[1] / rowsPerPixel - (y + 0.5)) < 8);
        }
        assert.equal(store.levelMetrics[0].decodeCount, before.decodeCount);
        assert.equal(store.levelMetrics[0].serializeCount, before.serializeCount);
    }
    trace.close();
});

test("Top-down-like view uses a detected composite allocation frontier", async () => {
    const trace = createCompositeAllocationTrace();
    const data = await buildCycleNavigatorData(trace, { binCycleCount: 1 });
    assert.ok(data?.topDown !== null && data?.topDown !== undefined);
    assert.equal(data.topDown.allocationStage.label, "0/ready/wait");
    assert.equal(data.topDown.executionStage.label, "0/execute-ready/execute-wait");
    assert.equal(data.topDown.allocationWidth, 3);
    const fullAllocation = getCycleNavigatorTopDown(data, 2, 3);
    assert.ok(fullAllocation !== null);
    assert.equal(fullAllocation.retiringSlots, 3);
    assert.equal(fullAllocation.frontendBound, 0);
    trace.close();
});

test("Trace navigator retains completed data in 32-cycle bins", async () => {
    const trace = createTopDownBreakdownTrace();
    appendTopDownBreakdownOp(trace, 4, [
        ["arbitrary-source", 40, 41],
        ["arbitrary-reservoir", 41, 43],
        ["arbitrary-event", 43, 44],
        ["arbitrary-tail", 44, 45],
    ]);
    appendTopDownBreakdownOp(trace, 5, [
        ["arbitrary-source", 70, 71],
        ["arbitrary-reservoir", 71, 73],
        ["arbitrary-event", 73, 74],
        ["arbitrary-tail", 74, 75],
    ]);
    const data = await buildCycleNavigatorData(trace);
    assert.ok(data !== null && data.topDown !== null);
    const binCount = Math.floor(data.cycleCount / 32);
    assert.equal(data.cycleActivity.binCycleCount, 32);
    assert.equal(data.topDown.slotCounts.length, binCount * 6);
    assert.equal(data.topDown.tailSlots.length,
        (data.observedCycleCount - data.cycleActivity.sealedCycle) *
            data.topDown.allocationWidth);
    assert.equal(data.cycleActivity.sealedCycle, binCount * 32);
    assert.equal(data.cycleActivity.fetch.bins.length, binCount);
    assert.ok(data.cycleActivity.fetch.bins instanceof Uint16Array);
    assert.ok(data.cycleActivity.fetch.tailValues instanceof Uint8Array);
    const full = getCycleNavigatorTopDown(data, 0, data.cycleCount);
    assert.ok(full !== null);
    assert.equal(full.totalSlots, data.cycleCount * data.topDown.allocationWidth);
    assert.equal(full.samplingStride, 32);
    const exact = await buildCycleNavigatorData(trace, { binCycleCount: 1 });
    const exactFull = exact === null ? null : getCycleNavigatorTopDown(exact, 0, exact.cycleCount);
    assert.ok(exactFull !== null);
    for (const category of [
        "retiringSlots",
        "squashedSlots",
        "recoveryBubbleSlots",
        "unresolvedSlots",
        "frontendBound",
        "backendBound",
    ] as const) {
        assert.equal(full[category], exactFull[category]);
    }
    for (const mode of ["fetch", "issue", "commit", "flush"] as const) {
        const binned = getCycleActivity(
            data.cycleActivity, data.cycleCount, mode, 0, data.cycleCount,
        );
        const unbinned = getCycleActivity(
            exact.cycleActivity, exact.cycleCount, mode, 0, exact.cycleCount,
        );
        assert.ok(binned !== null && unbinned !== null);
        assert.equal(binned.average, unbinned.average);
        assert.equal(binned.flushedAverage, unbinned.flushedAverage);
    }
    trace.close();
});

test("Live navigator keeps the unconfirmed tail at one-cycle resolution", async () => {
    const trace = createTopDownBreakdownTrace();
    appendTopDownBreakdownOp(trace, 4, [
        ["arbitrary-source", 40, 41],
        ["arbitrary-reservoir", 41, 43],
        ["arbitrary-event", 43, 44],
        ["arbitrary-tail", 44, 45],
    ]);
    const data = await buildCycleNavigatorData(trace, { live: true });
    assert.ok(data !== null && data.topDown !== null);
    assert.equal(data.confirmedCycle, 40);
    assert.equal(data.cycleActivity.sealedCycle, 32);
    assert.equal(data.cycleActivity.fetch.tailValues[40 - 32], 1);
    assert.equal(data.cycleActivity.fetch.tailValues[39 - 32], 0);
    const completedPrefix = getCycleActivity(
        data.cycleActivity, data.cycleCount, "fetch", 0, 32,
    );
    assert.ok(completedPrefix !== null);

    appendTopDownBreakdownOp(trace, 5, [
        ["arbitrary-source", 70, 71],
        ["arbitrary-reservoir", 71, 73],
        ["arbitrary-event", 73, 74],
        ["arbitrary-tail", 74, 75],
    ]);
    const advanced = updateCycleNavigatorData(data, trace);
    assert.equal(advanced.confirmedCycle, 70);
    assert.equal(advanced.cycleActivity.sealedCycle, 64);
    assert.equal(getCycleActivity(
        advanced.cycleActivity, advanced.cycleCount, "fetch", 0, 32,
    )?.average, completedPrefix.average);
    assert.equal(advanced.cycleActivity.fetch.maximum,
        data.cycleActivity.fetch.maximum);

    // EOFでは処理済みOpを走査し直さず、EOF markerを消費して末尾cycleを確定する。
    const eof = new Op();
    eof.id = 6;
    eof.eof = true;
    eof.fetchedCycle = 97;
    eof.retiredCycle = 100;
    const store = trace.opStore as ArrayOpStore;
    store.setOp(eof.id, eof);
    trace.updateLastCycle(100);
    const finished = updateCycleNavigatorData(advanced, trace, true);
    assert.equal(finished.sourceLastID, eof.id);
    assert.equal(finished.cycleCount, 100);
    assert.equal(finished.confirmedCycle, 100);
    assert.equal(finished.cycleActivity.sealedCycle, 96);
    trace.close();
});

test("Top-down-like analysis fixes its trace range while a live trace grows", async () => {
    const trace = createTopDownBreakdownTrace();
    const building = buildCycleNavigatorData(trace, { yieldInterval: 1 });

    // build開始後に、既存candidateの投入cycle順を壊す命令を同じlive traceへ追加する。
    // 今回のsnapshotへ混入すればallocation検出が失敗するため、結果から範囲固定を確認できる。
    appendTopDownBreakdownOp(trace, 4, [
        ["arbitrary-source", 2, 3],
        ["arbitrary-reservoir", 3, 12],
        ["arbitrary-event", 12, 13],
        ["arbitrary-tail", 13, 14],
    ]);

    const activity = await building;
    assert.ok(activity !== null && activity.topDown !== null);
    assert.equal(activity.topDown.allocationWidth, 2);
    trace.close();
});

test("Cycle navigator yields by elapsed time even below the initial sample size", async (t) => {
    const trace = createTopDownBreakdownTrace();
    const getOp = trace.getOpForScan.bind(trace);
    let clock = 0;
    let reads = 0;
    let canceled = false;
    t.mock.method(performance, "now", () => clock);
    t.mock.method(trace, "getOpForScan", (id: number) => {
        reads++;
        clock += 10;
        return getOp(id);
    });
    const building = buildCycleNavigatorData(trace, { isCanceled: () => canceled });
    assert.equal(reads, 1);
    canceled = true;
    assert.equal(await building, null);
    trace.close();
});

test("Cycle navigator resumes bounded updates without sealing unfinished cycles", async () => {
    const trace = createTopDownBreakdownTrace();
    let incremental = await buildCycleNavigatorData(trace, { live: true });
    const initial = await buildCycleNavigatorData(trace, { live: true });
    assert.ok(incremental !== null && initial !== null);
    for (let id = 4; id < 64; id++) {
        const cycle = id * 10;
        appendTopDownBreakdownOp(trace, id, [
            ["arbitrary-source", cycle, cycle + 1],
            ["arbitrary-reservoir", cycle + 1, cycle + 3],
            ["arbitrary-event", cycle + 3, cycle + 4],
            ["arbitrary-tail", cycle + 4, cycle + 5],
        ]);
    }
    const complete = updateCycleNavigatorData(initial, trace, true, Infinity);
    while (incremental.sourceLastID < trace.lastID) {
        const next = updateCycleNavigatorData(incremental, trace, true, 0);
        assert.equal(next.sourceLastID, incremental.sourceLastID + 1);
        if (next.sourceLastID < trace.lastID) {
            assert.ok(next.confirmedCycle < trace.lastCycle);
        }
        incremental = next;
    }
    assert.deepEqual(
        getCycleNavigatorTopDown(incremental, 0, trace.lastCycle),
        getCycleNavigatorTopDown(complete, 0, trace.lastCycle),
    );
    for (const mode of ["fetch", "issue", "commit", "flush", "latency"] as const) {
        assert.deepEqual(
            getCycleNavigatorActivity(incremental, mode, 0, trace.lastCycle),
            getCycleNavigatorActivity(complete, mode, 0, trace.lastCycle),
        );
    }
    trace.close();
});

test("Cycle navigator keeps stage-independent activity when stage structure is unavailable", async () => {
    const trace = createLatencyTrace([[2, 9], [3, 9]]);
    const data = await buildCycleNavigatorData(trace, { binCycleCount: 1 });
    assert.ok(data !== null);
    assert.equal(data.topDown, null);
    const commit = getCycleActivity(data.cycleActivity, data.cycleCount, "commit", 9, 10);
    assert.ok(commit !== null);
    assert.equal(commit.average, 2);
    assert.equal(commit.maximum, 2);

    const labels = createRecordedContext();
    const navigator = createRecordedContext();
    drawCycleNavigator(
        data,
        { ...DEFAULT_KONATA_RENDER_SPEC, position: [9, 0] },
        createCanvas(labels.context, 500, 128),
        createCanvas(navigator.context, 160, 128),
        "top-down",
        true,
    );
    assert.ok(labels.fillTexts.some(([text]) => text === "max 2 ops/cycle"));
    assert.ok(navigator.fillStyles.includes("hsl(140,35%,55%)"));

    const fetchLabels = createRecordedContext();
    const fetchNavigator = createRecordedContext();
    drawCycleNavigator(
        data,
        { ...DEFAULT_KONATA_RENDER_SPEC, position: [2, 0] },
        createCanvas(fetchLabels.context, 500, 128),
        createCanvas(fetchNavigator.context, 160, 128),
        "fetch",
        true,
    );
    assert.ok(fetchLabels.fillTexts.some(([text]) => text === "max 1 ops/cycle"));
    assert.ok(fetchNavigator.fillStyles.includes("hsl(240,35%,55%)"));

    const comparisonNavigator = createRecordedContext();
    const source = {
        data,
        spec: { ...DEFAULT_KONATA_RENDER_SPEC, position: [2, 0] },
    };
    drawComparisonCycleNavigator(
        { baseline: source, candidate: source },
        createCanvas(createRecordedContext().context, 500, 128),
        createCanvas(comparisonNavigator.context, 160, 128),
        "overlay",
        "fetch",
        true,
    );
    assert.ok(comparisonNavigator.fillStyles.includes("hsl(240,35%,55%)"));
    trace.close();
});

test("Cycle navigator counts throughput, flushed work, and latency", async () => {
    const trace = createCycleActivityTrace();
    const data = await buildCycleNavigatorData(trace, { binCycleCount: 1 });
    assert.ok(data !== null && data.topDown !== null);
    const analysis = data.topDown;
    const sample = (
        mode: "fetch" | "issue" | "commit" | "flush" | "latency",
        startCycle: number,
        endCycle: number,
    ) => getCycleActivity(
        data.cycleActivity,
        data.cycleCount,
        mode,
        startCycle,
        endCycle,
    );

    const fetch = sample("fetch", 2, 3);
    assert.ok(fetch !== null);
    assert.equal(fetch.average, 2);
    assert.equal(fetch.flushedAverage, 1);
    assert.equal(fetch.maximum, 2);
    const flushedIssue = sample("issue", 5, 6);
    assert.ok(flushedIssue !== null);
    assert.equal(flushedIssue.average, 1);
    assert.equal(flushedIssue.flushedAverage, 1);
    const issue = sample("issue", 12, 13);
    assert.ok(issue !== null);
    assert.equal(issue.average, 1);
    const commit = sample("commit", 17, 18);
    assert.ok(commit !== null);
    assert.equal(commit.average, 1);
    assert.equal(commit.flushedAverage, 0);

    const flush = sample("flush", 3, 4);
    assert.ok(flush !== null);
    assert.equal(flush.average, 1);
    const latency = sample("latency", 12, 13);
    assert.ok(latency !== null);
    assert.equal(latency.average, 4);
    assert.equal(latency.maximum, 4);

    const compactFetchLabels = createRecordedContext();
    drawCycleNavigator(
        data,
        { ...DEFAULT_KONATA_RENDER_SPEC, position: [2, 0] },
        createCanvas(compactFetchLabels.context, 500, 128),
        createCanvas(createRecordedContext().context, 160, 128),
        "fetch",
    );
    assert.equal(compactFetchLabels.fillTexts.length, 0);

    const fetchLabels = createRecordedContext();
    const fetchNavigator = createRecordedContext();
    drawCycleNavigator(
        data,
        { ...DEFAULT_KONATA_RENDER_SPEC, position: [2, 0] },
        createCanvas(fetchLabels.context, 500, 128),
        createCanvas(fetchNavigator.context, 160, 128),
        "fetch",
        true,
    );
    assert.ok(fetchLabels.fillTexts.some(([text, x, y]) =>
        text === "max 2 ops/cycle" && x === 128 && y === 16));
    assert.ok(fetchLabels.fillTexts.some(([text, , y]) =>
        text === "Later flushed" && y === 16));
    assert.ok(fetchNavigator.fillStyles.includes("hsl(0,0%,55%)"));
    const lightFetchNavigator = createRecordedContext();
    drawCycleNavigator(
        data,
        { ...DEFAULT_KONATA_RENDER_SPEC, position: [2, 0], theme: "light" },
        createCanvas(createRecordedContext().context, 500, 128),
        createCanvas(lightFetchNavigator.context, 160, 128),
        "fetch",
    );
    assert.ok(lightFetchNavigator.fillStyles.includes("rgba(0,0,0,0.35)"));

    const labels = createRecordedContext();
    const navigator = createRecordedContext();
    drawCycleNavigator(
        data,
        { ...DEFAULT_KONATA_RENDER_SPEC, position: [12, 0] },
        createCanvas(labels.context, 500, 128),
        createCanvas(navigator.context, 160, 128),
        "latency",
        true,
    );
    assert.ok(labels.fillTexts.some(([text]) =>
        text === "arbitrary-event → completion · max 4 cycles"));
    assert.ok(navigator.fillStyles.includes("hsl(280,35%,55%)"));
    trace.close();
});

test("Top-down-like live updates stop at gaps and follow the retired fetch frontier", async () => {
    const trace = createTopDownBreakdownTrace();
    // ID 6の正常リタイアでfetch cycle 20より前を確定させるが、ID 4の穴では停止する。
    appendTopDownBreakdownOp(trace, 6, [
        ["arbitrary-source", 20, 21],
        ["arbitrary-reservoir", 21, 22],
        ["arbitrary-event", 22, 23],
        ["arbitrary-tail", 23, 24],
    ]);
    const data = await buildCycleNavigatorData(trace, { binCycleCount: 1, live: true });
    assert.ok(data !== null && data.topDown !== null);
    appendTopDownBreakdownOp(trace, 5, [
        ["arbitrary-source", 12, 14],
        ["arbitrary-reservoir", 14, 16],
        ["arbitrary-event", 16, 17],
        ["arbitrary-tail", 17, 18],
    ]);
    const withGap = updateCycleNavigatorData(data, trace);
    assert.equal(withGap.sourceLastID, 3);
    assert.ok(withGap.topDown !== null);
    assert.ok(withGap.topDown.tailSlots.length >=
        (withGap.observedCycleCount - withGap.cycleActivity.sealedCycle) * 2);
    const backend = getCycleNavigatorTopDown(withGap, 13, 14);
    assert.equal(backend, null);

    appendTopDownBreakdownOp(trace, 4, [
        ["arbitrary-source", 12, 13],
        ["arbitrary-reservoir", 13, 15],
        ["arbitrary-event", 15, 16],
        ["arbitrary-tail", 16, 17],
    ]);
    const filled = updateCycleNavigatorData(withGap, trace);
    assert.equal(filled.sourceLastID, 6);
    const filledGap = getCycleNavigatorTopDown(filled, 13, 14);
    assert.ok(filledGap !== null);
    assert.equal(filledGap.retiringSlots, 1);
    assert.equal(filledGap.backendBound, 1);
    assert.equal(getCycleActivity(
        filled.cycleActivity, filled.cycleCount, "fetch", 12, 13,
    )?.average, 2);
    assert.equal(getCycleActivity(
        filled.cycleActivity, filled.cycleCount, "issue", 15, 16,
    )?.average, 1);
    assert.equal(updateCycleNavigatorData(filled, trace), filled);
    trace.close();
});

test("Stage-independent live activity updates without a detected structure", async () => {
    const trace = createLatencyTrace([[2, 9], [3, 9]]);
    const data = await buildCycleNavigatorData(trace, { binCycleCount: 1, live: true });
    assert.ok(data !== null && data.topDown === null);
    const store = trace.opStore as ArrayOpStore;
    for (const [id, fetchedCycle, retiredCycle] of [
        [2, 10, 15],
        [3, 20, 25],
    ] as const) {
        const op = new Op();
        op.id = id;
        op.rid = id;
        op.retired = true;
        op.fetchedCycle = fetchedCycle;
        op.retiredCycle = retiredCycle;
        store.setOp(id, op);
        store.setRetiredOp(id, op);
    }
    trace.updateLastCycle(25);

    const updated = updateCycleNavigatorData(data, trace);
    assert.equal(updated.sourceLastID, 3);
    assert.equal(getCycleActivity(
        updated.cycleActivity, updated.cycleCount, "fetch", 10, 11,
    )?.average, 1);
    assert.equal(getCycleActivity(
        updated.cycleActivity, updated.cycleCount, "commit", 15, 16,
    )?.average, 1);

    // cycle 25のcommitは表示境界20より後でもexact tailに残り、次の確定境界で現れる。
    const next = new Op();
    next.id = 4;
    next.rid = 4;
    next.retired = true;
    next.fetchedCycle = 30;
    next.retiredCycle = 35;
    store.setOp(4, next);
    store.setRetiredOp(4, next);
    trace.updateLastCycle(35);
    const advanced = updateCycleNavigatorData(updated, trace);
    assert.equal(advanced.cycleCount, 30);
    assert.equal(getCycleActivity(
        advanced.cycleActivity, advanced.cycleCount, "commit", 25, 26,
    )?.average, 1);
    trace.close();
});

test("Top-down-like view distinguishes allocated dependencies from allocation backpressure", async () => {
    const trace = createAllocationBlockedTrace();
    const activity = await buildCycleNavigatorData(trace, { binCycleCount: 1 });
    assert.ok(activity !== null);
    const analysis = activity.topDown;
    assert.ok(analysis !== null);
    assert.equal(analysis.allocationStage.stageName, "allocation");
    assert.equal(analysis.executionStage.stageName, "execution");
    assert.equal(analysis.allocationWidth, 4);
    assert.equal(analysis.admissionStages.length, 4);
    assert.equal(analysis.admissionStages[0].stage.stageName, "entry-a");
    assert.equal(analysis.admissionStages[0].typicalLatency, 1);

    const allocatedDependencies = getCycleNavigatorTopDown(activity, 4, 5);
    assert.ok(allocatedDependencies !== null);
    assert.equal(allocatedDependencies.retiringSlots, 4);
    assert.equal(allocatedDependencies.frontendBound, 0);
    assert.equal(allocatedDependencies.backendBound, 0);

    const blocked = getCycleNavigatorTopDown(activity, 6, 7);
    assert.ok(blocked !== null);
    assert.equal(blocked.frontendBound, 0);
    assert.equal(blocked.backendBound, 4);

    const labels = createRecordedContext();
    const cycleNavigator = createRecordedContext();
    drawCycleNavigator(
        activity,
        { ...DEFAULT_KONATA_RENDER_SPEC, position: [6, 0] },
        createCanvas(labels.context, 450, 128),
        createCanvas(cycleNavigator.context, 160, 128),
    );
    assert.ok(cycleNavigator.fillStyles.includes("hsl(30,35%,55%)"));
    trace.close();
});

test("Top-down-like view retrospectively classifies supported recovery bubbles", async () => {
    const trace = createRecoveryBubbleTrace(
        [...Array<number>(10).fill(3), 30],
        true,
    );
    const activity = await buildCycleNavigatorData(trace, { binCycleCount: 1 });
    assert.ok(activity !== null);
    const analysis = activity.topDown;
    assert.ok(analysis !== null);
    assert.equal(analysis.allocationStage.stageName, "arbitrary-reservoir");
    assert.equal(analysis.executionStage.stageName, "arbitrary-event");
    assert.equal(analysis.recoveryWindowCount, 11);
    assert.equal(analysis.minimumRecoveryCycles, 3);
    assert.equal(analysis.minimumRecoverySampleCount, 10);

    const sampled = getCycleNavigatorTopDown(activity, 0, activity.cycleCount);
    assert.ok(sampled !== null);
    assert.equal(sampled.samplingStride, 1);
    assert.equal(sampled.sampledCycleCount, activity.cycleCount);
    assert.equal(sampled.totalSlots, sampled.sampledCycleCount * analysis.allocationWidth);

    const sampleCycle = (cycle: number) => getCycleNavigatorTopDown(
        activity, cycle, cycle + 1,
    );
    const blocked = sampleCycle(12);
    assert.ok(blocked !== null);
    // resolution前のwrong-path命令が入口で止まった空きslotは、通常のBackend停滞である。
    assert.equal(blocked.backendBound, 1);
    assert.equal(blocked.recoveryBubbleSlots, 0);

    const recovered = sampleCycle(16);
    assert.ok(recovered !== null);
    assert.equal(recovered.frontendBound, 0);
    assert.equal(recovered.recoveryBubbleSlots, 1);

    const outlierBase = 10 + 10 * 50;
    const cappedOutlier = sampleCycle(outlierBase + 9);
    assert.ok(cappedOutlier !== null);
    // 単発の長いcorrect-path待ちは、反復観測した最短回復を越えればFrontendへ戻す。
    assert.equal(cappedOutlier.recoveryBubbleSlots, 0);
    assert.equal(cappedOutlier.frontendBound, 1);

    trace.close();
});

test("Top-down-like view does not learn recovery from an unsupported sample", async () => {
    const trace = createRecoveryBubbleTrace([30]);
    const activity = await buildCycleNavigatorData(trace, { binCycleCount: 1 });
    assert.ok(activity !== null);
    const analysis = activity.topDown;
    assert.ok(analysis !== null);
    assert.equal(analysis.recoveryWindowCount, 1);
    assert.equal(analysis.minimumRecoveryCycles, null);
    assert.equal(analysis.minimumRecoverySampleCount, 0);

    const beforeComplete = getCycleNavigatorTopDown(activity, 14, 15);
    assert.ok(beforeComplete !== null);
    assert.equal(beforeComplete.recoveryBubbleSlots, 0);
    assert.equal(beforeComplete.frontendBound, 1);
    const afterComplete = getCycleNavigatorTopDown(activity, 16, 17);
    assert.ok(afterComplete !== null);
    assert.equal(afterComplete.recoveryBubbleSlots, 0);
    assert.equal(afterComplete.frontendBound, 1);
    trace.close();
});

test("Top-down-like analysis stops after yielding when its pane is closed", async () => {
    const trace = createTopDownCancellationTrace();
    let canceled = false;
    const building = buildCycleNavigatorData(trace, {
        yieldInterval: 1,
        isCanceled: () => canceled,
    });
    canceled = true;
    assert.equal(await building, null);
    trace.close();
});

test("Web renderer keeps the legacy instruction label format", () => {
    const { op } = createTrace();
    // 左paneはfile-local ID、global ID、thread、retire ID、命令ラベルの順で表示する。
    assert.equal(formatOpLabel(op.id, op), "0: s100 (t1: r0): add x1, x2, x3");
    assert.equal(formatCompactOpLabel(op.id, op), "0: add x1, x2, x3");
});

test("Web renderer uses compact instruction labels in a narrow pane", () => {
    const { trace } = createTrace();
    const label = createRecordedContext();
    new KonataRenderer().drawLabelSpec(
        trace,
        DEFAULT_KONATA_RENDER_SPEC,
        createCanvas(label.context, 160),
    );
    assert.deepEqual(label.fillTexts.map(([text]) => text), ["0: add x1, x2, x3"]);
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

test("Web render metrics find the instruction row for a cycle", () => {
    const trace = createLatencyTrace([
        [100, 130],
        [100, 140],
        [200, 230],
    ]);
    const metrics = new KonataRenderMetrics(trace, DEFAULT_KONATA_RENDER_SPEC);

    assert.equal(metrics.getPositionYFromCycle(50), 0);
    assert.equal(metrics.getPositionYFromCycle(100), 0);
    assert.equal(metrics.getPositionYFromCycle(199), 0);
    assert.equal(metrics.getPositionYFromCycle(200), 2);
    assert.equal(metrics.getPositionYFromCycle(300), 2);
    trace.close();
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

test("Comparison overlay scrolling preserves the relative position of both traces", () => {
    const candidateTrace = createLatencyTrace([
        [100, 1000],
        [200, 220],
    ]);
    const baselineTrace = createLatencyTrace([
        [10, 20],
        [300, 900],
    ]);
    const horizontalAnchorPixel = 160;
    const candidateSpec = {
        ...DEFAULT_KONATA_RENDER_SPEC,
        position: [495, 0] as const,
    };
    const baselineSpec = {
        ...DEFAULT_KONATA_RENDER_SPEC,
        position: [395, 0] as const,
    };
    const independentlyMovedBaseline = new KonataRenderMetrics(
        baselineTrace,
        baselineSpec,
    ).withLogicalDifference([0, 1], true, horizontalAnchorPixel);
    const [candidate, baseline] = moveSynchronizedRenderSpecs(
        new KonataRenderMetrics(candidateTrace, candidateSpec),
        new KonataRenderMetrics(baselineTrace, baselineSpec),
        [0, 1],
        true,
        horizontalAnchorPixel,
    );
    const candidateDifferenceX = candidate.position[0] - candidateSpec.position[0];
    const baselineDifferenceX = baseline.position[0] - baselineSpec.position[0];

    // 個別補正なら異なるtrace latencyにより横移動量が分かれる入力で、同じ量を維持する。
    assert.ok(Math.abs(
        independentlyMovedBaseline.position[0] - baselineSpec.position[0] - candidateDifferenceX,
    ) > 1);
    assert.ok(Math.abs(baselineDifferenceX - candidateDifferenceX) < 1e-9);
    assert.equal(candidate.position[1] - candidateSpec.position[1], 1);
    assert.equal(baseline.position[1] - baselineSpec.position[1], 1);
    assert.ok(Math.abs(
        (candidate.position[0] - baseline.position[0]) -
        (candidateSpec.position[0] - baselineSpec.position[0]),
    ) < 1e-9);

    const [restoredCandidate, restoredBaseline] = moveSynchronizedRenderSpecs(
        new KonataRenderMetrics(candidateTrace, candidate),
        new KonataRenderMetrics(baselineTrace, baseline),
        [0, -1],
        true,
        horizontalAnchorPixel,
    );
    assert.ok(Math.abs(restoredCandidate.position[0] - candidateSpec.position[0]) < 1e-9);
    assert.ok(Math.abs(restoredBaseline.position[0] - baselineSpec.position[0]) < 1e-9);
    assert.equal(restoredCandidate.position[1], candidateSpec.position[1]);
    assert.equal(restoredBaseline.position[1], baselineSpec.position[1]);
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

test("Canvas backend aligns cached text to device pixels only at native text scale", () => {
    const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
    const atlas = createRecordedContext();
    Object.defineProperty(globalThis, "document", {
        configurable: true,
        value: { createElement: () => createCanvas(atlas.context) },
    });
    try {
        for (const ratio of [1, 1.25, 1.3, 1.5, 2]) {
            Object.defineProperty(globalThis, "window", {
                configurable: true,
                value: { devicePixelRatio: ratio },
            });
            for (const scale of [0.75, 1, 1.5, 2]) {
                for (const queued of [false, true]) {
                    const recorded = createRecordedContext();
                    const blits: number[][] = [];
                    recorded.context.drawImage = ((...args: unknown[]) => {
                        blits.push(args.slice(1) as number[]);
                    }) as CanvasRenderingContext2D["drawImage"];
                    const backend = new CanvasBackend();
                    if (queued) {
                        backend.begin(createCanvas(recorded.context), recorded.context, 257, 131, false);
                    }
                    backend.setTextStyle(recorded.context, "normal", 14, "monospace", "#ffffff", scale, true);
                    // Float32で半pixelのどちら側かが変わる位置、負座標も含める。
                    const xs = [12.5 - 1e-8, 12.5, 12.5 + 1e-8, -1.5];
                    for (const x of xs) {
                        backend.fillText("10", x / ratio, 35.5 / ratio);
                    }
                    if (queued) backend.end();
                    assert.equal(blits.length, xs.length);
                    assert.equal(recorded.context.imageSmoothingEnabled, scale < 1);
                    for (const [index, blit] of blits.entries()) {
                        const [, , sw, sh, dx, dy, dw, dh] = blit;
                        const atlasScale = Math.min(1, scale);
                        assert.ok(Math.abs(dw * ratio - sw * atlasScale) < 1e-6);
                        assert.ok(Math.abs(dh * ratio - sh * atlasScale) < 1e-6);
                        // mockのleft=0、padding=2なのでX offsetは-2物理px。
                        const expectedX = scale >= 1
                            ? Math.round(xs[index]) - 2
                            : xs[index] - 2 * scale;
                        assert.ok(Math.abs(dx * ratio - expectedX) < 1e-5,
                            JSON.stringify({ratio, scale, queued, dx, expectedX}));
                        if (scale >= 1) {
                            assert.ok(Math.abs(dy * ratio - Math.round(dy * ratio)) < 1e-6);
                        }
                    }
                    backend.dispose();
                }
            }
        }
    }
    finally {
        if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
        else Reflect.deleteProperty(globalThis, "document");
        if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
        else Reflect.deleteProperty(globalThis, "window");
    }
});

test("Canvas backend keeps uncached text and rectangle coordinates unsnapped", () => {
    const recorded = createRecordedContext();
    const backend = new CanvasBackend();
    backend.begin(createCanvas(recorded.context), recorded.context, 257, 131, false);
    backend.setTextStyle(recorded.context, "normal", 14, "monospace", "#ffffff", 2, false);
    backend.fillRect(0.25, 0.5, 12.75, 20.5);
    backend.fillText("10", 12.5, 35.5);
    backend.strokeRect(0.5, 1.5, 12.25, 21.75);
    backend.end();
    assert.deepEqual(recorded.fillTexts, [["10", 12.5, 35.5]]);
    assert.deepEqual(recorded.fillRects, [[0.25, 0.5, 12.75, 20.5]]);
    assert.deepEqual(recorded.strokeRects, [[0.5, 1.5, 12.25, 21.75]]);
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
