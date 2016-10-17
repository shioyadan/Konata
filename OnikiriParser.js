function OnikiriParser (Konata) {
    // メインプロセス内のKonataオブジェクト(親オブジェクト)
    // Op.js, Stage.js, Label.jsと色々使いたい物を持ってる
    this.Konata = Konata;
    this.file = null; 
    this.text = null;
    this.lines = null;
     // op情報のキャッシュ（配列）
     // op情報とはOp.jsで定義される連想配列とフェッチされた行数情報（メタデータ）
     // [op, lineIndex];
    this.opCache = [];
    // Line情報のキャッシュ（配列）
    // Line情報とは、Nライン目においてフェッチされているOP番号やサイクル数の情報
    this.lineCache = [];
    this.lastIndex = null;
    this.name = "OnikiriParser";
    this.timeout = 600 * 1000; // パースを諦めるまでの時間[ms](0なら諦めない)

    // Public methods
    this.GetName = function () {
        return "OnikiriParser:(" + this.file.path + ")";
    };

    this.SetFile = function (file) {
        this.file = file;
        var text = "";
        if (this.file.IsText()) {
            text = this.file.buf.toString();
        } else {
            // 圧縮データなら展開する
            text = "Extracted";
        }
        if (!this.Check(text)) {
            return false;   // 知らない文法ならなにもしない。
        }
        this.lines = text.split("\n");
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
        if (this.opCache[id] != null) {
            op = this.opCache[id][0];
        } else {
            op = null;//this.Search(id);
            //this.opCache[id][0] = op;
        }
        return op;
    }

    // Private mothods(javascriptにそういう機能があるわけではない)
    // this.textの文法を確認し、Onikiriのものでなさそうならfalse
    this.Check = function (text) {
        return true;
    }

    // idに対応するop情報をthis.linesから検索する。
    this.Search = function (id) {
        var op = new this.Konata.Op({"id":id});
        for (var cachedId = id; cachedId > 0; i--) {
            if (this.cache[cachedId] != null) {
                break;
            }
        }
        var start = cache[cachedId][1]; // 
        for (var i = start, len = this.lines.length; i < len; i++) {
            var line = this.GetLine(id, i);
            if (line == null) {
                continue;
            }
        }
    }

    // ops[id]に関係する行であればその行を返す
    this.GetLine = function (id, lineIndex) {

    }

    this.ParseAllLines = function () {
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
            this.ParseCommand(c, cycle, command.slice(1), i);
        }
        var i = this.opCache.length - 1;
        while (i >= 0) {
            var op = this.opCache[i][0];
            if (op.retired && !op.flush) {
                break; // フラッシュされた命令がきたら終了
            }
            i--;
            if (op.flush) {
                continue; // フラッシュされた命令には特になにもしない
            }
            op.retiredCycle = cycle;
            op.eof = true;
        }
        return true;
    }

    this.ParseCommand = function(command, cycle ,args, lineIdx) {
        var id = Number(args[0]);
        var op;
        if (this.opCache[id]) {
            op = this.opCache[id][0];
        } else {
            op = null;
        }
        if (command.match(/^(L|S|E|R|W)$/) && op == null) {
            // error
        }
        switch(command) {
            case "I":
                op = new this.Konata.Op({id:id});
                op.gid = args[1];
                op.tid = args[2];
                op.fetchedCycle = cycle;
                this.opCache[id] = [op, lineIdx];
                break;
            case "L":
                var visible = Number(args[1]) == 0? true:false;
                var label = new this.Konata.Label({text:args[2], visible:visible});
                op.labels.push(label);
                break;
            case "S":
                var laneName = args[1];
                var stageName = args[2];
                var stage = new this.Konata.Stage({name:stageName, startCycle:cycle});
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
                this.opCache[prodId][0].cons.push([id, type, cycle]);
                break;
         }
    }
};

module.exports = OnikiriParser;
