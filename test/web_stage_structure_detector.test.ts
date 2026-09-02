import assert from "node:assert/strict";
import test from "node:test";

import { StageStructureDetector } from "../src/core/stage_structure_detector";
import { Lane, Op, Stage } from "../src/core/model";

function addLane(
    op: Op,
    laneID: number,
    ranges: readonly (readonly [string, number, number])[],
): void {
    const lane = new Lane();
    for (const [name, startCycle, endCycle] of ranges) {
        const stage = new Stage();
        stage.name = name;
        stage.startCycle = startCycle;
        stage.endCycle = endCycle;
        lane.stages.push(stage);
    }
    op.lanes[laneID] = lane;
}

function createOp(id: number, retired = true, flush = false): Op {
    const op = new Op();
    op.id = id;
    op.gid = id;
    op.tid = 0;
    op.retired = retired;
    op.flush = flush;
    op.retiredCycle = 20;
    return op;
}

function finishDetector(detector: StageStructureDetector, ops: readonly Readonly<Op>[]) {
    const measurement = detector.finish();
    if (measurement === null) {
        return null;
    }
    for (const op of ops) {
        measurement.observe(op);
    }
    return measurement.finish();
}

test("Stage structure detector finds the allocation neighborhood", () => {
    const detector = new StageStructureDetector();
    const ops: Op[] = [];
    const timings = [
        { start: 2, end: 8, retired: true, flush: false },
        { start: 2, end: 6, retired: false, flush: true },
        { start: 2, end: 7, retired: true, flush: false },
        { start: 3, end: 9, retired: true, flush: false },
    ] as const;
    timings.forEach((timing, id) => {
        const op = createOp(id, timing.retired, timing.flush);
        addLane(op, 0, [
            ["source", Math.max(0, timing.start - 1), timing.start],
            ["queue", timing.start, timing.end],
            ["execution", timing.end, timing.end + 1],
            ["complete", timing.end + 1, timing.end + 2],
        ]);
        ops.push(op);
        detector.observe(op);
    });
    const eof = createOp(timings.length);
    eof.eof = true;
    addLane(eof, 0, [["queue", 0, 1]]);
    ops.push(eof);
    detector.observe(eof);

    const structure = finishDetector(detector, ops);
    assert.ok(structure !== null);
    assert.deepEqual(structure.allocationStage, {
        laneID: 0,
        stageNames: ["queue"],
        // flush命令も観測されたallocation幅を消費するが、順序性の証拠には使わない。
        width: 3,
    });
    assert.deepEqual(structure.executionStage, {
        laneID: 0,
        stageNames: ["execution"],
    });
    assert.equal(structure.transitionCoverage, 1);
    assert.deepEqual(structure.admissionStages, [{
        laneID: 0,
        stageName: "source",
        typicalLatency: 1,
    }]);
    assert.deepEqual(structure.observe(ops[0]), {
        allocationCycle: 2,
        issueCycle: 8,
        executionLatency: 1,
        completionCycle: 9,
        admissionStallStartCycle: 2,
        admissionStallEndCycle: 2,
    });
});

test("Stage structure detector merges alternative queue states and ignores isolated lanes", () => {
    const detector = new StageStructureDetector();
    const ops: Op[] = [];
    const timings = [
        { stage: "ready", start: 2, end: 8, stallEnd: 12 },
        { stage: "wait", start: 2, end: 9, stallEnd: 11 },
        { stage: "ready", start: 2, end: 6, stallEnd: 10 },
        { stage: "wait", start: 3, end: 7, stallEnd: 9 },
    ] as const;
    timings.forEach((timing, id) => {
        const op = createOp(id);
        const execution = timing.stage === "ready" ? "execute-ready" : "execute-wait";
        addLane(op, 0, [
            ["source", timing.start - 1, timing.start],
            [timing.stage, timing.start, timing.end],
            [execution, timing.end, timing.end + 1],
            ["complete", timing.end + 1, timing.end + 2],
        ]);
        // 単独laneのstall表示もin-order投入／OoO退出になるが、pipeline構造ではない。
        addLane(op, 1, [["stall", 1, timing.stallEnd]]);
        ops.push(op);
        detector.observe(op);
    });

    const structure = finishDetector(detector, ops);
    assert.deepEqual(structure?.allocationStage, {
        laneID: 0,
        stageNames: ["ready", "wait"],
        // ready 2件、wait 1件が同じcycleに入るため、個別最大ではなく集合幅は3。
        width: 3,
    });
    assert.deepEqual(structure?.executionStage, {
        laneID: 0,
        stageNames: ["execute-ready", "execute-wait"],
    });
    assert.equal(structure?.transitionCoverage, 1);
    assert.deepEqual(structure?.admissionStages, [{
        laneID: 0,
        stageName: "source",
        typicalLatency: 1,
    }]);
    assert.deepEqual(structure?.observe(ops[1]), {
        allocationCycle: 2,
        issueCycle: 9,
        executionLatency: 1,
        completionCycle: 10,
        admissionStallStartCycle: 2,
        admissionStallEndCycle: 2,
    });
});

test("Stage structure detector rejects allocation without exit reordering", () => {
    const detector = new StageStructureDetector();
    for (let id = 0; id < 4; id++) {
        const op = createOp(id);
        addLane(op, 0, [
            ["source", id, id + 1],
            ["queue", id + 1, id + 3],
            ["tail", id + 3, id + 4],
        ]);
        detector.observe(op);
    }
    assert.equal(detector.finish(), null);
});

test("Stage structure detector does not merge serial queue candidates", () => {
    const detector = new StageStructureDetector();
    const ops: Op[] = [];
    const timings = [
        { firstStart: 1, firstEnd: 8, secondStart: 10, secondEnd: 15 },
        { firstStart: 1, firstEnd: 6, secondStart: 10, secondEnd: 13 },
        { firstStart: 2, firstEnd: 7, secondStart: 11, secondEnd: 14 },
    ] as const;
    timings.forEach((timing, id) => {
        const op = createOp(id);
        addLane(op, 0, [
            ["source", timing.firstStart - 1, timing.firstStart],
            ["queue-a", timing.firstStart, timing.firstEnd],
            ["middle", timing.firstEnd, timing.secondStart],
            ["queue-b", timing.secondStart, timing.secondEnd],
            ["tail", timing.secondEnd, timing.secondEnd + 1],
        ]);
        ops.push(op);
        detector.observe(op);
    });
    assert.equal(finishDetector(detector, ops), null);
});

test("Stage structure detector rejects ambiguous allocation candidates", () => {
    const detector = new StageStructureDetector();
    const ends = [8, 6, 9];
    ends.forEach((endCycle, id) => {
        const op = createOp(id);
        addLane(op, 0, [
            ["source-a", id, id + 1],
            ["queue-a", id + 1, endCycle],
            ["tail-a", endCycle, endCycle + 1],
        ]);
        addLane(op, 1, [
            ["source-b", id, id + 1],
            ["queue-b", id + 1, endCycle + 10],
            ["tail-b", endCycle + 10, endCycle + 11],
        ]);
        detector.observe(op);
    });
    assert.equal(detector.finish(), null);
});
