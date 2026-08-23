import assert from "node:assert/strict";
import test from "node:test";

import { Dependency, Lane, Op, ParsedTrace, Stage, StageLevelMap } from "../src/core/model";
import { ArrayOpStore } from "../src/core/op_store";
import { CanvasBackend } from "../src/core/canvas_backend";
import {
    buildStageActivity,
    drawStageActivityHeatmap,
    getStageActivityAverage,
    getStageActivitySample,
    getStageTopDownBreakdownSample,
    getStageStartRate,
} from "../src/core/stage_activity_heatmap";
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
        fillAlphas,
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

function createStageActivityTrace(cycleCount = 8): ParsedTrace {
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

function createMispredictionShadowTrace(
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
        "misprediction-shadow.log",
        store,
        levelMap,
        Math.max(1, lastEndCycle + 1),
    );
}

test("Stage activity aggregates overlapping intervals and flushed ops", async () => {
    const trace = createStageActivityTrace();
    const activity = await buildStageActivity(trace);
    assert.ok(activity !== null);
    assert.equal(activity.binWidth, 1);
    assert.equal(activity.binCount, 8);
    assert.deepEqual(activity.rows.map((row) => row.label), ["X"]);
    const row = activity.rows[0];
    assert.deepEqual(
        Array.from({ length: activity.binCount }, (_, cycle) =>
            getStageActivityAverage(row, activity.binWidth, cycle, cycle + 1, false)),
        [1, 1, 2, 2, 1, 1, 0, 0],
    );
    assert.deepEqual(
        Array.from({ length: activity.binCount }, (_, cycle) =>
            getStageActivityAverage(row, activity.binWidth, cycle, cycle + 1, true)),
        [1, 1, 1, 1, 0, 0, 0, 0],
    );
    assert.equal(row.totalPeak, 2);
    assert.equal(row.nonFlushedPeak, 1);
    assert.equal(activity.totalPeak, 2);
    assert.equal(activity.nonFlushedPeak, 1);
    assert.deepEqual(
        Array.from({ length: activity.binCount }, (_, cycle) =>
            getStageStartRate(row, activity.binWidth, cycle, cycle + 1, false)),
        [1, 0, 1, 0, 0, 0, 0, 0],
    );
    assert.deepEqual(
        Array.from({ length: activity.binCount }, (_, cycle) =>
            getStageStartRate(row, activity.binWidth, cycle, cycle + 1, true)),
        [1, 0, 0, 0, 0, 0, 0, 0],
    );
    assert.equal(row.totalStartPeak, 1);
    assert.equal(row.nonFlushedStartPeak, 1);
    assert.equal(activity.totalStartPeak, 1);
    assert.equal(activity.nonFlushedStartPeak, 1);

    const multiStageTrace = createStageActivityTrace();
    const multiStageOp = multiStageTrace.getOpForScan(0);
    assert.ok(multiStageOp !== undefined);
    const multiStageLane = multiStageOp.lanes[0];
    assert.ok(multiStageLane !== null);
    const smallerStage = new Stage();
    smallerStage.name = "arbitrary-small-stage";
    smallerStage.startCycle = 0;
    smallerStage.endCycle = 4;
    multiStageLane.stages.push(smallerStage);
    multiStageTrace.stageLevelMap.update("0", smallerStage.name, multiStageLane);
    const multiStageActivity = await buildStageActivity(multiStageTrace);
    assert.ok(multiStageActivity !== null);
    assert.equal(multiStageActivity.totalPeak, 2);
    assert.deepEqual(
        multiStageActivity.rows.map((activityRow) => [activityRow.stageName, activityRow.totalPeak]),
        [["X", 2], ["arbitrary-small-stage", 1]],
    );
    multiStageTrace.close();

    const coarse = await buildStageActivity(trace, { maxCellCount: 2 });
    assert.ok(coarse !== null);
    assert.equal(coarse.binWidth, 4);
    assert.equal(coarse.binCount, 2);
    assert.equal(getStageActivityAverage(coarse.rows[0], 4, 0, 4, false), 1.5);
    assert.equal(getStageActivityAverage(coarse.rows[0], 4, 4, 8, false), 0.5);
    assert.equal(getStageStartRate(coarse.rows[0], 4, 0, 4, false), 0.5);
    assert.equal(getStageStartRate(coarse.rows[0], 4, 0, 4, true), 0.25);
    assert.equal(coarse.rows[0].totalStartPeak, 0.5);
    assert.equal(coarse.rows[0].nonFlushedStartPeak, 0.25);
    trace.close();

    const partialLastBinTrace = createStageActivityTrace(7);
    const partialLastBin = await buildStageActivity(partialLastBinTrace, { maxCellCount: 2 });
    assert.ok(partialLastBin !== null);
    assert.equal(partialLastBin.binWidth, 4);
    assert.ok(Math.abs(
        getStageActivityAverage(partialLastBin.rows[0], 4, 4, 7, false) - 2 / 3,
    ) < 1e-6);
    partialLastBinTrace.close();
});

test("Stage starts retain same-cycle events even for zero-width stages", async () => {
    const store = new ArrayOpStore();
    const levelMap = new StageLevelMap();
    const laneID = levelMap.getOrCreateLaneID("0");
    [1, 1, 2].forEach((cycle, id) => {
        const op = new Op();
        op.id = id;
        op.rid = id;
        op.retired = true;
        op.fetchedCycle = cycle;
        op.retiredCycle = cycle + 1;
        const lane = new Lane();
        const stage = new Stage();
        stage.name = "arbitrary-width-stage";
        stage.startCycle = cycle;
        stage.endCycle = cycle;
        lane.stages.push(stage);
        op.lanes[laneID] = lane;
        levelMap.update("0", stage.name, lane);
        store.setOp(id, op);
        store.setRetiredOp(id, op);
    });
    const trace = new ParsedTrace("starts.log", store, levelMap, 4);
    const activity = await buildStageActivity(trace);
    assert.ok(activity !== null);
    const row = activity.rows[0];
    assert.equal(row.totalPeak, 0);
    assert.equal(row.totalStartPeak, 2);
    assert.deepEqual(
        Array.from({ length: 4 }, (_, cycle) =>
            getStageStartRate(row, 1, cycle, cycle + 1, false)),
        [0, 2, 1, 0],
    );
    trace.close();
});

test("Top-down-like view classifies allocation slots without stage names", async () => {
    const trace = createTopDownBreakdownTrace();
    const activity = await buildStageActivity(trace);
    assert.ok(activity !== null);
    const analysis = activity.topDownAnalysis;
    assert.ok(analysis !== null);
    assert.equal(activity.rows[analysis.allocationRowIndex].stageName, "arbitrary-reservoir");
    assert.equal(activity.rows[analysis.executionRowIndex].stageName, "arbitrary-event");
    assert.equal(analysis.allocationWidth, 2);
    assert.equal(analysis.transitionCount, 4);
    assert.equal(analysis.transitionCoverage, 1);
    assert.equal(analysis.admissionRows.length, 1);
    assert.equal(activity.rows[analysis.admissionRows[0].rowIndex].stageName, "arbitrary-source");
    assert.equal(analysis.admissionRows[0].typicalLatency, 1);

    const fullAllocation = getStageTopDownBreakdownSample(
        activity,
        { ...DEFAULT_KONATA_RENDER_SPEC, position: [3, 0] },
        0,
        160,
    );
    assert.ok(fullAllocation !== null);
    assert.equal(fullAllocation.totalSlots, 2);
    assert.equal(fullAllocation.retiringSlots, 1);
    assert.equal(fullAllocation.squashedSlots, 1);
    assert.equal(fullAllocation.unresolvedSlots, 0);
    assert.equal(fullAllocation.frontendBound, 0);
    assert.equal(fullAllocation.backendBound, 0);

    const partialAllocation = getStageTopDownBreakdownSample(
        activity,
        { ...DEFAULT_KONATA_RENDER_SPEC, position: [3, 0] },
        32,
        160,
    );
    assert.ok(partialAllocation !== null);
    assert.equal(partialAllocation.totalSlots, 2);
    assert.equal(partialAllocation.retiringSlots, 0);
    assert.equal(partialAllocation.squashedSlots, 0);
    assert.equal(partialAllocation.unresolvedSlots, 1);
    // execution待ちの命令が残っていても、allocation入口が詰まっていなければFrontend。
    assert.equal(partialAllocation.frontendBound, 1);
    assert.equal(partialAllocation.backendBound, 0);

    const postSquashGap = getStageTopDownBreakdownSample(
        activity,
        { ...DEFAULT_KONATA_RENDER_SPEC, position: [3, 0] },
        96,
        160,
    );
    assert.ok(postSquashGap !== null);
    assert.equal(postSquashGap.totalSlots, 2);
    // squash後の空白だけからrecoveryを推定せず、入口backpressureがなければFrontend。
    assert.equal(postSquashGap.squashedSlots, 0);
    assert.equal(postSquashGap.frontendBound, 2);
    assert.equal(postSquashGap.backendBound, 0);

    const frontend = getStageTopDownBreakdownSample(
        activity,
        { ...DEFAULT_KONATA_RENDER_SPEC, position: [9, 0] },
        0,
        160,
    );
    assert.ok(frontend !== null);
    assert.equal(frontend.totalSlots, 2);
    assert.equal(frontend.retiringSlots, 1);
    assert.equal(frontend.frontendBound, 1);
    assert.equal(frontend.backendBound, 0);

    const labels = createRecordedContext();
    const heatmap = createRecordedContext();
    drawStageActivityHeatmap(
        activity,
        { ...DEFAULT_KONATA_RENDER_SPEC, position: [3, 0] },
        createCanvas(labels.context, 450, 128),
        createCanvas(heatmap.context, 320, 128),
        "topdown",
        "global",
    );
    assert.ok(labels.fillTexts.some(([text]) => text === "Top-down-like (auto)"));
    assert.ok(labels.fillTexts.some(([text]) => text.includes("arbitrary-event")));
    assert.ok(labels.fillTexts.some(([text]) => text.includes("arbitrary-reservoir")));
    assert.ok(labels.fillTexts.some(([text]) => text.includes("entrance arbitrary-source +1c")));
    assert.ok(heatmap.fillRects.length > 0);
    for (const color of ["#66bb6a", "#ef5350", "#42a5f5", "#b0bec5"]) {
        assert.ok(heatmap.fillStyles.includes(color));
    }
    trace.close();
});

test("Top-down-like view distinguishes allocated dependencies from allocation backpressure", async () => {
    const trace = createAllocationBlockedTrace();
    const activity = await buildStageActivity(trace);
    assert.ok(activity !== null);
    const analysis = activity.topDownAnalysis;
    assert.ok(analysis !== null);
    assert.equal(activity.rows[analysis.allocationRowIndex].stageName, "allocation");
    assert.equal(activity.rows[analysis.executionRowIndex].stageName, "execution");
    assert.equal(analysis.allocationWidth, 4);
    assert.equal(analysis.admissionRows.length, 4);
    assert.equal(activity.rows[analysis.admissionRows[0].rowIndex].stageName, "entry-a");
    assert.equal(analysis.admissionRows[0].typicalLatency, 1);

    const allocatedDependencies = getStageTopDownBreakdownSample(
        activity,
        { ...DEFAULT_KONATA_RENDER_SPEC, position: [4, 0] },
        0,
        160,
    );
    assert.ok(allocatedDependencies !== null);
    assert.equal(allocatedDependencies.retiringSlots, 4);
    assert.equal(allocatedDependencies.frontendBound, 0);
    assert.equal(allocatedDependencies.backendBound, 0);

    const blocked = getStageTopDownBreakdownSample(
        activity,
        { ...DEFAULT_KONATA_RENDER_SPEC, position: [6, 0] },
        0,
        160,
    );
    assert.ok(blocked !== null);
    assert.equal(blocked.frontendBound, 0);
    assert.equal(blocked.backendBound, 4);

    const labels = createRecordedContext();
    const heatmap = createRecordedContext();
    drawStageActivityHeatmap(
        activity,
        { ...DEFAULT_KONATA_RENDER_SPEC, position: [6, 0] },
        createCanvas(labels.context, 450, 128),
        createCanvas(heatmap.context, 160, 128),
        "topdown",
        "global",
    );
    assert.ok(heatmap.fillStyles.includes("#ffa726"));
    trace.close();
});

test("Top-down-like view retrospectively classifies supported misprediction shadows", async () => {
    const trace = createMispredictionShadowTrace(
        [...Array<number>(10).fill(3), 30],
        true,
    );
    const activity = await buildStageActivity(trace);
    assert.ok(activity !== null);
    const analysis = activity.topDownAnalysis;
    assert.ok(analysis !== null);
    assert.equal(activity.rows[analysis.allocationRowIndex].stageName, "arbitrary-reservoir");
    assert.equal(activity.rows[analysis.executionRowIndex].stageName, "arbitrary-event");
    assert.equal(analysis.mispredictionWindowCount, 11);
    assert.equal(analysis.minimumRecoveryCycles, 3);
    assert.equal(analysis.minimumRecoverySampleCount, 10);

    const sampleCycle = (cycle: number) => getStageTopDownBreakdownSample(
        activity,
        { ...DEFAULT_KONATA_RENDER_SPEC, position: [cycle, 0] },
        0,
        160,
    );
    const blocked = sampleCycle(12);
    assert.ok(blocked !== null);
    // 入口で止まった命令自体が後にflushされるなら、有効なBackend仕事ではない。
    assert.equal(blocked.backendBound, 0);
    assert.equal(blocked.mispredictionShadowSlots, 1);

    const recovered = sampleCycle(16);
    assert.ok(recovered !== null);
    assert.equal(recovered.frontendBound, 0);
    assert.equal(recovered.mispredictionShadowSlots, 1);

    const outlierBase = 10 + 10 * 50;
    const cappedOutlier = sampleCycle(outlierBase + 9);
    assert.ok(cappedOutlier !== null);
    // 単発の長いcorrect-path待ちは、反復観測した最短回復を越えればFrontendへ戻す。
    assert.equal(cappedOutlier.mispredictionShadowSlots, 0);
    assert.equal(cappedOutlier.frontendBound, 1);

    const labels = createRecordedContext();
    drawStageActivityHeatmap(
        activity,
        { ...DEFAULT_KONATA_RENDER_SPEC, position: [10, 0] },
        createCanvas(labels.context, 500, 128),
        createCanvas(createRecordedContext().context, 160, 128),
        "topdown",
        "global",
    );
    assert.ok(labels.fillTexts.some(([text]) => text.includes("shadow 11, +3c min")));
    trace.close();
});

test("Top-down-like view does not learn recovery from an unsupported sample", async () => {
    const trace = createMispredictionShadowTrace([30]);
    const activity = await buildStageActivity(trace);
    assert.ok(activity !== null);
    const analysis = activity.topDownAnalysis;
    assert.ok(analysis !== null);
    assert.equal(analysis.mispredictionWindowCount, 1);
    assert.equal(analysis.minimumRecoveryCycles, null);
    assert.equal(analysis.minimumRecoverySampleCount, 0);

    const beforeComplete = getStageTopDownBreakdownSample(
        activity,
        { ...DEFAULT_KONATA_RENDER_SPEC, position: [14, 0] },
        0,
        160,
    );
    assert.ok(beforeComplete !== null);
    assert.equal(beforeComplete.mispredictionShadowSlots, 1);
    const afterComplete = getStageTopDownBreakdownSample(
        activity,
        { ...DEFAULT_KONATA_RENDER_SPEC, position: [16, 0] },
        0,
        160,
    );
    assert.ok(afterComplete !== null);
    assert.equal(afterComplete.mispredictionShadowSlots, 0);
    assert.equal(afterComplete.frontendBound, 1);
    trace.close();
});

test("Stage activity stops after yielding when its pane is closed", async () => {
    const trace = createStageActivityTrace();
    let canceled = false;
    const building = buildStageActivity(trace, {
        yieldInterval: 1,
        isCanceled: () => canceled,
    });
    canceled = true;
    assert.equal(await building, null);
    trace.close();
});

test("Stage activity heatmap follows the pipeline cycle scale and Unique colors", async () => {
    const trace = createStageActivityTrace();
    const activity = await buildStageActivity(trace);
    assert.ok(activity !== null);
    const labels = createRecordedContext();
    const heatmap = createRecordedContext();
    drawStageActivityHeatmap(
        activity,
        {
            ...DEFAULT_KONATA_RENDER_SPEC,
            theme: "light",
            position: [1, 0],
        },
        createCanvas(labels.context, 160, 32),
        createCanvas(heatmap.context, 160, 32),
        "active",
        "stage",
    );

    assert.deepEqual(labels.fillTexts.map(([text]) => text), ["X", "peak 2"]);
    assert.ok(heatmap.fillRects.some(([x, _y, width]) => x === 0 && width === 32));
    assert.ok(heatmap.fillAlphas.some((alpha) => alpha === 0.5));
    assert.ok(heatmap.fillAlphas.some((alpha) => alpha === 1));
    assert.ok(labels.fillRects.some(([_x, _y, width, height]) => width > 100 && height === 2));
    assert.deepEqual(heatmap.gradients[0]?.stops, [
        [0, "hsl(250,95%,95%)"],
        [1, "hsl(250,70%,80%)"],
    ]);

    const sample = getStageActivitySample(
        activity,
        { ...DEFAULT_KONATA_RENDER_SPEC, position: [1, 0] },
        "active",
        32,
        0,
        160,
        32,
    );
    assert.ok(sample !== null);
    assert.equal(sample.startCycle, 2);
    assert.equal(sample.activity, 2);
    assert.equal(sample.rowPeak, 2);
    assert.equal(sample.relativeLevel, 1);
    assert.equal(sample.peakShare, 1);
    assert.equal(sample.startCount, 1);
    assert.equal(sample.startRate, 1);
    assert.equal(sample.startPeak, 1);

    const startsSample = getStageActivitySample(
        activity,
        { ...DEFAULT_KONATA_RENDER_SPEC, position: [1, 0] },
        "starts",
        32,
        0,
        160,
        32,
    );
    assert.ok(startsSample !== null);
    assert.equal(startsSample.rowPeak, 1);
    assert.equal(startsSample.relativeLevel, 1);

    const startsHeatmap = createRecordedContext();
    drawStageActivityHeatmap(
        activity,
        { ...DEFAULT_KONATA_RENDER_SPEC, position: [1, 0] },
        createCanvas(createRecordedContext().context, 160, 32),
        createCanvas(startsHeatmap.context, 160, 32),
        "starts",
        "stage",
    );
    assert.ok(startsHeatmap.fillAlphas.some((alpha) => alpha === 1));

    const globalStartsHeatmap = createRecordedContext();
    drawStageActivityHeatmap(
        { ...activity, totalStartPeak: 2, nonFlushedStartPeak: 2 },
        { ...DEFAULT_KONATA_RENDER_SPEC, position: [1, 0] },
        createCanvas(createRecordedContext().context, 160, 32),
        createCanvas(globalStartsHeatmap.context, 160, 32),
        "starts",
        "global",
    );
    assert.ok(globalStartsHeatmap.fillAlphas.some((alpha) => alpha === 0.5));

    const globalHeatmap = createRecordedContext();
    drawStageActivityHeatmap(
        { ...activity, totalPeak: 4, nonFlushedPeak: 2 },
        { ...DEFAULT_KONATA_RENDER_SPEC, position: [1, 0] },
        createCanvas(createRecordedContext().context, 160, 32),
        createCanvas(globalHeatmap.context, 160, 32),
        "active",
        "global",
    );
    assert.ok(globalHeatmap.fillAlphas.some((alpha) => alpha === 0.25));
    assert.ok(globalHeatmap.fillAlphas.some((alpha) => alpha === 0.5));
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
