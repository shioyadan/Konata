"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {OnikiriParser} = require("../onikiri_parser");
const {parseText} = require("./helpers/fake_file_reader");

// I/L/S/E/R/W/Cの主要コマンドを2命令で組み合わせた最小ログ。
// fixture内へ説明行を入れると未知コマンドとして解釈されるため、意図はこのテスト側に記す。
const basicFixture = fs.readFileSync(
    path.join(__dirname, "fixtures", "kanata-basic.txt"),
    "utf8"
);

test("OnikiriParser records stages, labels, retire/flush, and dependencies", async () => {
    const parser = new OnikiriParser();
    await parseText(parser, basicFixture);

    // id=0,1の2命令を読み、正常retireしたid=0だけが最大rid=0になる。
    // flushされたid=1はridを持つが、正常retire命令の索引には登録されない。
    assert.equal(parser.name, "OnikiriParser");
    assert.equal(parser.lastID, 1);
    assert.equal(parser.lastRID, 0);
    assert.equal(parser.lastCycle, 5);
    assert.deepEqual(Object.keys(parser.laneMap).sort(), ["0", "1"]);
    assert.equal(parser.stageLevelMap.laneNum, 2);

    const producer = parser.getOp(0);
    const consumer = parser.getOp(1);

    assert.ok(producer);
    assert.ok(consumer);
    // I/Rコマンドから命令識別子、thread、寿命、retire種別を復元できることを確認する。
    assert.deepEqual(
        {
            id: producer.id,
            gid: producer.gid,
            rid: producer.rid,
            tid: producer.tid,
            retired: producer.retired,
            flush: producer.flush,
            fetchedCycle: producer.fetchedCycle,
            retiredCycle: producer.retiredCycle,
        },
        {
            id: 0,
            gid: 100,
            rid: 0,
            tid: 0,
            retired: true,
            flush: false,
            fetchedCycle: 0,
            retiredCycle: 4,
        }
    );
    // \nの文字列は表示用の改行へ戻し、retire後に現れたLコマンドも既存Opへ追記する。
    // 後者は警告を出しつつ情報を失わない、現行ログとの互換動作である。
    assert.equal(producer.labelName, "producer\nname");
    assert.equal(producer.labelDetail, "producer detail; post-retire detail");
    // X開始cycleを消費時刻、X終了cycleの1つ前を生成時刻として依存線描画に用いる。
    assert.equal(producer.consCycle, 1);
    assert.equal(producer.prodCycle, 2);
    // 同一laneで次のSが来た場合、明示的なEがなくても直前stageをそのcycleで閉じる。
    // このfixtureではFをcycle 1、XをRt開始時のcycle 3で自動的に閉じる。
    assert.deepEqual(
        producer.lanes["0"].stages.map((stage) => ({
            name: stage.name,
            labels: stage.labels,
            startCycle: stage.startCycle,
            endCycle: stage.endCycle,
        })),
        [
            {name: "F", labels: "", startCycle: 0, endCycle: 1},
            {name: "X", labels: "execute\nlabel", startCycle: 1, endCycle: 3},
            {name: "Rt", labels: "", startCycle: 3, endCycle: 4},
        ]
    );

    // Wはconsumer側のprodsとproducer側のconsを同じcycle/typeで双方向に構築する。
    assert.deepEqual(
        producer.cons.map((dependency) => ({...dependency})),
        [{opID: 1, type: 7, cycle: 3}]
    );
    assert.deepEqual(
        consumer.prods.map((dependency) => ({...dependency})),
        [{opID: 0, type: 7, cycle: 3}]
    );
    // Rのflushフラグが1ならretired=falseとし、ログ上のridと終了cycleは保持する。
    assert.equal(consumer.retired, false);
    assert.equal(consumer.flush, true);
    assert.equal(consumer.rid, 1);
    assert.equal(consumer.fetchedCycle, 3);
    assert.equal(consumer.retiredCycle, 5);
    assert.deepEqual(
        consumer.lanes["0"].stages.map((stage) => [stage.name, stage.startCycle, stage.endCycle]),
        [["F", 3, 4]]
    );
    // lane 1のstlにはEがないため、flush時に最後のstageをcycle 5で閉じる。
    assert.deepEqual(
        consumer.lanes["1"].stages.map((stage) => [stage.name, stage.startCycle, stage.endCycle]),
        [["stl", 3, 5]]
    );
});

test("OnikiriParser keeps an unfinished final op as EOF data", async () => {
    const parser = new OnikiriParser();
    // 最終命令にRがない、シミュレーション途中で終了したログを再現する。
    await parseText(parser, [
        "Kanata\t0004",
        "I\t0\t42\t0",
        "S\t0\t0\tF",
        "C\t2",
    ].join("\n"));

    const op = parser.getOp(0);
    assert.ok(op);
    // 終端後処理は未完了命令を捨てずeofとしてOpListへ移し、最後のstageを表示できるよう
    // retiredCycleを最終cycleの1つ後に置く。正常retireではないためlastRIDは更新しない。
    assert.equal(parser.lastID, 0);
    assert.equal(parser.lastRID, -1);
    assert.equal(op.eof, true);
    assert.equal(op.retired, false);
    assert.equal(op.flush, false);
    assert.equal(op.fetchedCycle, 0);
    assert.equal(op.retiredCycle, 3);
});

test("OnikiriParser rejects a non-Kanata header as unsupported", async () => {
    const parser = new OnikiriParser();
    // 先頭行がKanataでなければ壊れたKanataログではなく別形式として通知し、
    // 上位のKonataがgem5など次候補へフォールバックできるようにする。
    await assert.rejects(
        parseText(parser, "not a Kanata trace\n"),
        (error) => error.fileNotSupport === true
    );
});
