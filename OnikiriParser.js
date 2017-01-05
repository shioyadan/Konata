function OnikiriParser () {

    let Op = require("./Op");
    let File = require("./File");
    let Stage = require("./Stage");
    let Label = require("./Label");

    var m_file = null; 
    this.text = null;
    this.lines = null;
     // op情報のキャッシュ（配列）
     // op情報とはOp.jsで定義される連想配列とフェッチされた行数情報（メタデータ）
     // [op, lineIndex];
    var m_opCache = [];
    // Line情報のキャッシュ（配列）
    // Line情報とは、Nライン目においてフェッチされているOP番号やサイクル数の情報
    this.lineCache = [];
    this.lastIndex = null;
    this.name = "OnikiriParser";
    this.timeout = 600 * 1000; // パースを諦めるまでの時間[ms](0なら諦めない)
    var m_complete = false;
    // Public methods
    this.GetName = function () {
        return "OnikiriParser:(" + m_file.GetPath() + ")";
    };

    this.SetFile = function (file) {
        m_file = file;
        var text = "";
        if (m_file.IsText()) {
            text = m_file.GetText();
            this.lines = text.split("\n");
        } else if (m_file.GetExtension() == ".gz") {
            // 圧縮データなら展開する
            console.log("Extract");
            m_file.Extract().then(this.ParseAllLines, null);
            throw "Wait";
        } else {
            return false;
        }
        if (!Check(text)) {
            return false;   // 知らない文法ならなにもしない。
        }
        return this.ParseAllLines();
    };

    this.GetOps = function (start, end) {
        var ops = [];
        for (var i = start; i < end; i++) {
            var op = this.GetOp(i);
            ops.push(op);
            if (op == null) {
                // opがnullなら、それ以上の命令はない
                break;
            }
        }
        return ops;
    }

    this.GetOp = function(id) {
        var op;
        if (m_opCache[id] != null) {
            op = m_opCache[id][0];
        } else {
            op = null;//this.Search(id);
            //m_opCache[id][0] = op;
        }
        if (op == null && !m_complete) {
            throw("Parsing...");
        }
        return op;
    }

    // Private methods
    // this.textの文法を確認し、Onikiriのものでなさそうならfalse
    function Check (text) {
        return true;
    }

    this.ParseAllLines = function (text) {
        if (text) {
            this.text = text;
            this.lines = text.split("\n");
        }
        m_complete = false;
        var lines = this.lines;
        var cycle = 0;
        var startTime = new Date();
        for (var i = 0, len = lines.length; i < len; i++) {
            if (this.timeout != 0 && i % 10000 == 0) { // N行に一度くらい経過時間を確認する
                var endTime = new Date();
                if (endTime - startTime > this.timeout) {
                    return false; // パースに時間がかかり過ぎているなら諦める。
                }
            }
            var command = lines[i].trim().split("\t");
            var c = command[0];
            if (c == "C") {
                cycle += Number(command[1]);
                continue;
            }
            ParseCommand(c, cycle, command.slice(1), i);
        }
        var i = m_opCache.length - 1;
        while (i >= 0) {
            var op = m_opCache[i][0];
            if (op.retired && !op.flush) {
                break; // コミットされた命令がきたら終了
            }
            i--;
            if (op.flush) {
                continue; // フラッシュされた命令には特になにもしない
            }
            op.retiredCycle = cycle;
            op.eof = true;
        }
        m_complete = true;
        console.log("parse complete");
        return true;
    }

    function ParseCommand (command, cycle ,args, lineIdx) {
        var id = Number(args[0]);
        var op;
        if (m_opCache[id]) {
            op = m_opCache[id][0];
        } else {
            op = null;
        }
        if (command.match(/^(L|S|E|R|W)$/) && op == null) {
            // error
        }
        switch(command) {
            case "I":
                op = new Op({id:id});
                op.gid = args[1];
                op.tid = args[2];
                op.fetchedCycle = cycle;
                m_opCache[id] = [op, lineIdx];
                break;
            case "L":
                var visible = Number(args[1]) == 0? true:false;
                var label = new Label({text:args[2], visible:visible});
                op.labels.push(label);
                break;
            case "S":
                var laneName = args[1];
                var stageName = args[2];
                var stage = new Stage({name:stageName, startCycle:cycle});
                if (op.lanes[laneName] == null) {
                    op.lanes[laneName] = [];
                }
                //var lane = op.lanes[laneName];
                op.lanes[laneName].push(stage);
                break;
            case "E":
                var laneName = args[1];
                var stageName = args[2];
                var stage = null;
                var lane = op.lanes[laneName];
                for (var i = lane.length - 1; i >= 0; i--) {
                    if (lane[i].name == stageName) {
                        stage = lane[i];
                        break;
                    }
                }
                if (stage == null) {
                    break;
                }
                stage.endCycle = cycle;
                break;
            case "R":
                op.retired = true;
                op.rid = args[1];
                op.retiredCycle = cycle;
                if (Number(args[2] == 1)) {
                    op.flush = true;
                }
                break;
            case "W":
                var prodId = Number(args[1]);
                var type = Number(args[2]);
                op.prods.push([prodId, type, cycle]);
                m_opCache[prodId][0].cons.push([id, type, cycle]);
                break;
         }
    }
};

module.exports = OnikiriParser;
