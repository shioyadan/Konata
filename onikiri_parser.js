class OnikiriParser{

    constructor(){
        this.Op = require("./Op").Op;
        this.Stage = require("./Stage");
        this.Label = require("./Label");

        this.file_ = null; 
        
        this.text = null;
        this.lines = null;

        // 現在読み出し中のサイクル
        this.curCycle = 0;
        
        // op情報のキャッシュ（配列）
        // op情報とはOp.jsで定義される連想配列とフェッチされた行数情報（メタデータ）
        // [op, lineIndex];
        this.opCache_ = [];
        
        // Line情報のキャッシュ（配列）
        // Line情報とは、Nライン目においてフェッチされているOP番号やサイクル数の情報
        this.lineCache = [];
        this.lastIndex = null;
        this.name = "OnikiriParser";
        this.timeout = 600 * 1000; // パースを諦めるまでの時間[ms](0なら諦めない)
        
        this.complete_ = false;

    }
    
    // Public methods
    getName(){
        return "OnikiriParser:(" + this.file_.GetPath() + ")";
    }

    setFile(file){
        this.file_ = file;
        let text = "";
        if (this.file_.IsText()) {
            text = this.file_.GetText();
            this.lines = text.split("\n");
        } else if (this.file_.GetExtension() == ".gz") {
            // 圧縮データなら展開する
            console.log("Extract");
            this.file_.Extract().then(this.parseAllLines, null);
            throw "Wait";
        } else {
            return false;
        }
        if (!this.check(text)) {
            return false;   // 知らない文法ならなにもしない。
        }
        return this.parseAllLines();
    }

    getOps(start, end){
        let ops = [];
        for (let i = start; i < end; i++) {
            let op = this.getOp(i);
            ops.push(op);
            if (op == null) {
                // opがnullなら、それ以上の命令はない
                break;
            }
        }
        return ops;
    }

    getOp(id){
        let op;
        if (this.opCache_[id] != null) {
            op = this.opCache_[id][0];
        } else {
            op = null;//this.Search(id);
            //this.opCache_[id][0] = op;
        }
        if (op == null && !this.complete_) {
            throw("Parsing...");
        }
        return op;
    }

    // Private methods
    // this.textの文法を確認し、Onikiriのものでなさそうならfalse
    check(text){
        return true;
    }

    parseAllLines(text){
        if (text) {
            this.text = text;
            this.lines = text.split("\n");
        }
        this.complete_ = false;
        let lines = this.lines;
        
        this.curCycle = 0;

        let startTime = new Date();
        for (let i = 0, len = lines.length; i < len; i++) {
            if (this.timeout != 0 && i % 10000 == 0) { // N行に一度くらい経過時間を確認する
                let endTime = new Date();
                if (endTime - startTime > this.timeout) {
                    return false; // パースに時間がかかり過ぎているなら諦める。
                }
            }
            let command = lines[i].trim().split("\t");
            let c = command[0];
            if (c == "C") {
                this.curCycle += Number(command[1]);
                continue;
            }
            this.parseCommand(c, command.slice(1), i);
        }

        // 鬼斬側でリタイア処理が行われなかった終端部分の後処理
        let i = this.opCache_.length - 1;
        while (i >= 0) {
            let op = this.opCache_[i][0];
            if (op.retired && !op.flush) {
                break; // コミットされた命令がきたら終了
            }
            i--;
            if (op.flush) {
                continue; // フラッシュされた命令には特になにもしない
            }
            op.retiredCycle = this.curCycle;
            op.eof = true;
        }
        this.complete_ = true;

        console.log("parse complete");
        return true;
    }

    parseCommand(command, args, lineIdx){
        let id = Number(args[0]);
        let op;
        
        if (this.opCache_[id]) {
            op = this.opCache_[id][0];
        } else {
            op = null;
        }
        
        if (command.match(/^(L|S|E|R|W)$/) && op == null) {
            // error
        }

        switch(command) {
        case "I": {
            op = new this.Op();
            op.id = id;
            op.gid = args[1];
            op.tid = args[2];
            op.fetchedCycle = this.curCycle;
            this.opCache_[id] = [op, lineIdx];
            break;
        }

        case "L": {
            let visible = Number(args[1]) == 0? true:false;
            let label = new this.Label({text:args[2], visible:visible});
            op.labels.push(label);
            break;
        }

        case "S": {
            let laneName = args[1];
            let stageName = args[2];
            let stage = new this.Stage({name:stageName, startCycle:this.curCycle});
            if (op.lanes[laneName] == null) {
                op.lanes[laneName] = [];
            }
            //var lane = op.lanes[laneName];
            op.lanes[laneName].push(stage);
            break;
        }

        case "E": {
            let laneName = args[1];
            let stageName = args[2];
            let stage = null;
            let lane = op.lanes[laneName];
            for (let i = lane.length - 1; i >= 0; i--) {
                if (lane[i].name == stageName) {
                    stage = lane[i];
                    break;
                }
            }
            if (stage == null) {
                break;
            }
            stage.endCycle = this.curCycle;
            break;
        }

        case "R": {
            op.retired = true;
            op.rid = args[1];
            op.retiredCycle = this.curCycle;
            if (Number(args[2] == 1)) {
                op.flush = true;
            }
            break;
        }

        case "W": {
            let prodId = Number(args[1]);
            let type = Number(args[2]);
            op.prods.push([prodId, type, this.curCycle]);
            this.opCache_[prodId][0].cons.push([id, type, this.curCycle]);
            break;
        }
        }  // switch end
    }
}

module.exports.OnikiriParser = OnikiriParser;
