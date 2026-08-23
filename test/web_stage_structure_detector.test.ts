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

test("Stage structure detector finds the unique in-order entry with out-of-order exits", () => {
    const detector = new StageStructureDetector();
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
        ]);
        detector.observe(op);
    });
    const eof = createOp(timings.length);
    eof.eof = true;
    addLane(eof, 0, [["queue", 0, 1]]);
    detector.observe(eof);

    assert.deepEqual(detector.finish(), {
        allocation: {
            laneID: 0,
            stageName: "queue",
            // flush命令も観測されたallocation幅を消費するが、順序性の証拠には使わない。
            width: 3,
        },
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
    assert.equal(detector.finish().allocation, null);
});

test("Stage structure detector rejects ambiguous allocation candidates", () => {
    const detector = new StageStructureDetector();
    const ends = [8, 6, 9];
    ends.forEach((endCycle, id) => {
        const op = createOp(id);
        addLane(op, 0, [["queue-a", id, endCycle]]);
        addLane(op, 1, [["queue-b", id, endCycle + 10]]);
        detector.observe(op);
    });
    assert.equal(detector.finish().allocation, null);
});
