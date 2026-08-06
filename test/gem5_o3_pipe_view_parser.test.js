"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {Gem5O3PipeViewParser} = require("../gem5_o3_pipe_view_parser");
const {parseText, withoutConsoleLog} = require("./helpers/fake_file_reader");

// 1000 tick間隔で全ステージを通る1命令だけを含む。
// 生ログとしての形式を検証対象に含めるため、fixture内にはコメントを入れない。
const basicFixture = fs.readFileSync(
    path.join(__dirname, "fixtures", "gem5-basic.txt"),
    "utf8"
);

test("Gem5O3PipeViewParser converts ticks and pipeline stages", async () => {
    const parser = new Gem5O3PipeViewParser();
    await withoutConsoleLog(() => parseText(parser, basicFixture));

    // seqNum=10を先頭命令のid=0へ割り当て、正常retireをrid=0へ登録できることを確認する。
    // tickは最小差分の1000で割り、先頭tickをcycle 0とするため、7000 tickはcycle 6になる。
    assert.equal(parser.name, "Gem5O3PipeViewParser");
    assert.equal(parser.lastID, 0);
    assert.equal(parser.lastRID, 0);
    assert.equal(parser.lastCycle, 6);
    assert.deepEqual(Object.keys(parser.laneMap), ["0"]);

    const op = parser.getOp(0);
    assert.ok(op);
    // complete開始時を依存線の消費・生成cycleとして使う現行の描画契約も固定する。
    assert.deepEqual(
        {
            id: op.id,
            gid: op.gid,
            rid: op.rid,
            retired: op.retired,
            flush: op.flush,
            fetchedCycle: op.fetchedCycle,
            retiredCycle: op.retiredCycle,
            consCycle: op.consCycle,
            prodCycle: op.prodCycle,
        },
        {
            id: 0,
            gid: 10,
            rid: 0,
            retired: true,
            flush: false,
            fetchedCycle: 0,
            retiredCycle: 6,
            consCycle: 5,
            prodCycle: 5,
        }
    );
    // fetch行のアドレスと逆アセンブル文字列を、左側表示用ラベルへ連結する仕様を確認する。
    assert.equal(op.labelName, "0x00001000:  add r1, r2");
    // 新ステージの開始tickで直前ステージを閉じ、retireはCmだけを閉じてRtを追加しない。
    assert.deepEqual(
        op.lanes["0"].stages.map((stage) => [stage.name, stage.startCycle, stage.endCycle]),
        [
            ["F", 0, 1],
            ["Dc", 1, 2],
            ["Rn", 2, 3],
            ["Ds", 3, 4],
            ["Is", 4, 5],
            ["Cm", 5, 6],
        ]
    );
});

test("Gem5O3PipeViewParser rejects input without O3PipeView records", async () => {
    const parser = new Gem5O3PipeViewParser();
    // fileNotSupport=trueは、上位のKonataが次のパーサを試すために必要な区別である。
    await assert.rejects(
        withoutConsoleLog(() => parseText(parser, "ordinary log line\n")),
        (error) => error.fileNotSupport === true
    );
});
