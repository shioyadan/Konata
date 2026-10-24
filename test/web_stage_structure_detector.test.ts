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
        executionAttempts: [{ issueCycle: 8, latency: 1 }],
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
        const ranges: [string, number, number][] = [
            ["source", timing.start - 1, timing.start],
            [timing.stage, timing.start, timing.end],
            [execution, timing.end, timing.end + 1],
            ["complete", timing.end + 1, timing.end + 2],
        ];
        if (id === 0) {
            ranges.push([timing.stage, timing.end + 2, timing.end + 3],
                [execution, timing.end + 3, timing.end + 4],
                ["complete", timing.end + 4, timing.end + 5]);
        }
        addLane(op, 0, ranges);
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
        executionAttempts: [{ issueCycle: 9, latency: 1 }],
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

test("Stage structure detector separates first allocation from reselection and upstream replay", () => {
    const detector = new StageStructureDetector();
    const ops = [createOp(0), createOp(1), createOp(2)];
    addLane(ops[0], 0, [
        ["source", 1, 2], ["queue", 2, 8], ["execution", 8, 9],
        ["queue", 9, 10], ["execution", 10, 12], ["complete", 12, 13],
        ["source", 13, 14], ["queue", 14, 16], ["execution", 16, 17],
        ["complete", 17, 18], ["tail", 18, 20],
    ]);
    addLane(ops[1], 0, [
        ["source", 1, 2], ["queue", 2, 6], ["execution", 6, 7],
        ["complete", 7, 8], ["tail", 8, 20],
    ]);
    addLane(ops[2], 0, [
        ["source", 2, 3], ["queue", 3, 9], ["execution", 9, 10],
        ["complete", 10, 11], ["tail", 11, 20],
    ]);
    for (const op of ops) detector.observe(op);
    const structure = finishDetector(detector, ops);
    assert.ok(structure !== null);
    assert.deepEqual(structure.allocationStage, { laneID: 0, stageNames: ["queue"], width: 2 });
    assert.deepEqual(structure.executionStage, { laneID: 0, stageNames: ["execution"] });
    assert.deepEqual(structure.admissionStages, [{ laneID: 0, stageName: "source", typicalLatency: 1 }]);
    assert.equal(structure.transitionCoverage, 1);
    assert.deepEqual(structure.observe(ops[0]), {
        allocationCycle: 2,
        executionAttempts: [
            { issueCycle: 8, latency: 1 }, { issueCycle: 10, latency: 2 }, { issueCycle: 16, latency: 1 },
        ],
        completionCycle: 17, admissionStallStartCycle: 2, admissionStallEndCycle: 2,
    });

    // 一度完了しても上流へ戻れば、その完了をrecoveryの根拠にしてはいけない。
    // 最後の試行の後段が観測されない場合も、過去の完了を引き継がない。
    for (const suffix of [
        [["source", 10, 20]],
        [["queue", 10, 12]],
        [["queue", 10, 12], ["execution", 12, 20]],
    ] as const) {
        const canceled = createOp(3, false, true);
        addLane(canceled, 0, [
            ["source", 1, 2], ["queue", 2, 8], ["execution", 8, 9],
            ["complete", 9, 10], ...suffix,
        ]);
        const observation = structure.observe(canceled);
        assert.equal(observation.allocationCycle, 2);
        assert.equal(observation.completionCycle, null);
        assert.equal(observation.executionAttempts.length, suffix.length === 2 ? 2 : 1);
    }
});

test("Stage structure detector joins allocation states through a shared replay path", () => {
    const detector = new StageStructureDetector();
    const ops = Array.from({ length: 5 }, (_, id) => createOp(id));
    // retryは新規投入先にも再試行の入口にもなる。各候補の初回投入はID順だが、
    // 同じ命令がready／waitからretryへ移り、既に通ったexecuteへ戻る。
    const paths: (readonly [string, number, number])[][] = [
        [["source", 1, 2], ["ready", 2, 8], ["execute", 8, 9], ["complete", 9, 10],
            ["retry", 10, 18], ["execute", 18, 19], ["complete", 19, 20]],
        // この命令自身には戻りがない。後の命令の経路を根拠にwait→retryも許可する。
        [["source", 1, 2], ["wait", 2, 9],
            ["retry", 10, 17], ["execute", 17, 18], ["complete", 18, 20]],
        [["source", 2, 3], ["wait", 3, 7], ["execute", 7, 10],
            ["retry", 10, 16], ["execute", 16, 17], ["complete", 17, 20]],
        [["source", 2, 3], ["ready", 3, 6], ["execute", 6, 7], ["complete", 7, 10],
            ["retry", 10, 15], ["execute", 15, 16], ["complete", 16, 20]],
        [["source", 9, 10], ["retry", 10, 14], ["execute", 14, 15], ["complete", 15, 20]],
    ];
    ops.forEach((op, id) => {
        op.retiredCycle = 30;
        addLane(op, 0, [...paths[id], ["tail", 20, 30]]);
        detector.observe(op);
    });
    const structure = finishDetector(detector, ops);
    assert.ok(structure !== null);
    assert.deepEqual(structure.allocationStage, { laneID: 0, stageNames: ["ready", "retry", "wait"], width: 2 });
    assert.deepEqual(structure.executionStage, { laneID: 0, stageNames: ["execute"] });
    // retryの初回退出の多くは既訪問のexecuteへの戻りであり、新規遷移には含まない。
    assert.equal(structure.transitionCoverage, 5 / 9);
    assert.deepEqual(structure.observe(ops[0]), {
        allocationCycle: 2, executionAttempts: [{ issueCycle: 8, latency: 1 }, { issueCycle: 18, latency: 1 }],
        completionCycle: 19, admissionStallStartCycle: 2, admissionStallEndCycle: 2,
    });
    assert.equal(structure.observe(ops[1]).allocationCycle, 2);
    assert.equal(structure.observe(ops[1]).executionAttempts.length, 1);
    assert.equal(structure.observe(ops[4]).allocationCycle, 10);
});

test("Stage structure detector does not merge serial queue candidates even with downstream replay", () => {
    for (const replay of [false, true]) {
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
                ...(replay ? [
                    ["execute", timing.secondEnd, 16], ["retry", 16, 20 - id],
                    ["execute", 20 - id, 21],
                ] as [string, number, number][] : []),
                ["tail", replay ? 21 : timing.secondEnd, 30],
            ]);
            ops.push(op);
            detector.observe(op);
        });
        // 未完了／破棄命令だけの戻りで、二つの正常な直列queueを統合しない。
        for (const eof of [false, true]) {
            const op = createOp(ops.length, eof, !eof);
            op.eof = eof;
            addLane(op, 0, [
                ["source", 2, 3], ["queue-a", 3, 12], ["execute", 12, 13],
                ["queue-b", 13, 14], ["execute", 14, 15], ["tail", 15, 30],
            ]);
            ops.push(op);
            detector.observe(op);
        }
        assert.equal(finishDetector(detector, ops), null);
    }
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

function createIssueOps(): Op[] {
    const ops = [createOp(0), createOp(1), createOp(2)];
    const paths = [
        [["source", 1, 2], ["waiting", 2, 3], ["ready", 3, 4],
            ["alu", 4, 6], ["complete", 6, 7]],
        [["source", 1, 2], ["ready", 2, 4], ["waiting", 4, 5],
            ["load", 5, 6], ["complete", 6, 7]],
        [["source", 2, 3], ["waiting", 3, 6], ["ready", 6, 7],
            ["alu", 7, 9], ["complete", 9, 10]],
    ] as const;
    ops.forEach((op, id) => addLane(op, 0, paths[id]));
    return ops;
}

function finishIssue(ops: readonly Op[]) {
    const detector = new StageStructureDetector();
    ops.forEach((op) => detector.observe(op));
    const measurement = detector.finishIssue();
    ops.forEach((op) => measurement?.observe(op));
    return measurement?.finish() ?? null;
}

test("Issue-cycle detection joins interchangeable buffer states and validates all execution branches", () => {
    const ops = createIssueOps();
    const structure = finishIssue(ops);
    assert.ok(structure);
    assert.equal(structure.basis, "issue-cycles");
    assert.deepEqual(structure.allocationStage.stageNames, ["waiting", "ready"]);
    assert.deepEqual(structure.executionStage.stageNames, ["alu", "load"]);
    assert.equal(structure.minimumBufferLatency, 2);
    assert.equal(structure.transitionCoverage, 1);
    assert.deepEqual(structure.observe(ops[1]), {
        allocationCycle: 2, executionAttempts: [{ issueCycle: 5, latency: 1 }], completionCycle: null,
        admissionStallStartCycle: null, admissionStallEndCycle: null,
        issueBufferRanges: [{ startCycle: 2, endCycle: 5 }],
    });

    // 各実行stage内だけではID順に見えても、branch全体で逆転する場合は拒否する。
    addLane(ops[1], 0, [["source", 1, 2], ["ready", 2, 3], ["waiting", 3, 3],
        ["load", 3, 4], ["complete", 4, 5]]);
    assert.equal(finishIssue(ops), null);
});

test("Issue-cycle detection rejects ambiguous lanes, serial buffers and insufficient normal evidence", () => {
    const lanes = createIssueOps();
    lanes.forEach((op) => { op.lanes[1] = op.lanes[0]; });
    assert.equal(finishIssue(lanes), null);
    const threads = createIssueOps();
    threads[1].tid = 1;
    assert.equal(finishIssue(threads), null);
    const incomplete = createIssueOps();
    incomplete[2].eof = true;
    assert.equal(finishIssue(incomplete), null);
    const serial = createIssueOps();
    serial.forEach((op, id) => {
        addLane(op, 0, [["source", id + 1, id + 2], ["buffer-a", id + 2, id * 2 + 4],
            ["middle", id * 2 + 4, id * 2 + 5], ["buffer-b", id * 2 + 5, id * 3 + 7],
            ["execute", id * 3 + 7, id * 3 + 8], ["complete", id * 3 + 8, id * 3 + 9]]);
    });
    assert.equal(finishIssue(serial), null);
    const constant = Array.from({ length: 4 }, (_, id) => {
        const op = createOp(id, id < 3, id === 3);
        addLane(op, 0, [["source", id + 1, id + 2], ["buffer", id + 2, id === 3 ? 12 : id + 4],
            ["execute", id === 3 ? 12 : id + 4, id === 3 ? 13 : id + 5]]);
        return op;
    });
    assert.equal(finishIssue(constant), null);
});
