"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const {Konata} = require("../konata");
const {withoutConsoleLog} = require("./helpers/fake_file_reader");

function openKonata(filePath) {
    // 単体テスト用Readerを使わず、拡張子判定やgzip展開を含む実際のFileReader経路を通す。
    const konata = new Konata();
    return new Promise((resolve, reject) => {
        konata.openFile(
            filePath,
            () => {},
            () => resolve(konata),
            (error) => reject(new Error(String(error)))
        );
    });
}

test("Konata falls back from the Kanata parser to the gem5 parser", async () => {
    const fixture = path.join(__dirname, "fixtures", "gem5-basic.txt");
    const konata = await withoutConsoleLog(() => openKonata(fixture));
    try {
        // reloadはOnikiriParserを先に試す。Kanataでないという判定を受けてファイルを開き直し、
        // Gem5O3PipeViewParserで同じ入力を最後まで読めることを一連で確認する。
        assert.equal(konata.parser_.name, "Gem5O3PipeViewParser");
        assert.equal(konata.lastID, 0);
        assert.equal(konata.lastRID, 0);
        assert.equal(konata.getOp(0).gid, 10);
    }
    finally {
        // 成否にかかわらずストリームを閉じ、後続テストへファイル記述子を持ち越さない。
        await withoutConsoleLog(async () => konata.close());
    }
});

test("Konata parses the bundled gzip sample with stable summary values", async () => {
    const fixture = path.resolve(__dirname, "..", "docs", "kanata-sample-2.log.gz");
    const konata = await withoutConsoleLog(() => openKonata(fixture));
    try {
        // 付属サンプルを実際にgzip展開し、パーサ選択と全体件数が変わっていないことを固定する。
        // 小さなfixtureだけでは検出しにくい、行読み出しやOpList格納の回帰を拾うための基準値である。
        assert.equal(konata.parser_.name, "OnikiriParser");
        assert.equal(konata.lastID, 4040);
        assert.equal(konata.lastRID, 3625);
        assert.deepEqual(Object.keys(konata.laneMap).sort(), ["0", "1"]);
        assert.equal(konata.stageLevelMap.laneNum, 2);

        const first = konata.getOp(0);
        const last = konata.getOp(konata.lastID);
        assert.ok(first);
        assert.ok(last);
        // 先頭命令の代表値で、IDとラベルの対応がずれていないことを確認する。
        assert.deepEqual(
            {id: first.id, gid: first.gid, labelName: first.labelName},
            {id: 0, gid: 4, labelName: "00001000: jal zero, 0x10"}
        );
        // サンプル末尾はretire前に終了するため、終端後処理でeof命令として残るのが現行仕様である。
        assert.equal(last.id, 4040);
        assert.equal(last.eof, true);
    }
    finally {
        await withoutConsoleLog(async () => konata.close());
    }
});
