class OnikiriParser{

    constructor(){
        this.Op = require("./Op").Op;
        this.Stage = require("./Stage");

        this.file_ = null; 
        
        this.text = null;
        this.lines = null;

        // 現在読み出し中のサイクル
        this.curCycle = 0;

        // 最後に読み出された命令の ID
        this.lastID_ = -1;
        
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

    get lastID(){
        return this.lastID_;
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
            if (this.timeout != 0 && i % (1024*16) == 0) { // N行に一度くらい経過時間を確認する
                let endTime = new Date();
                if (endTime - startTime > this.timeout) {
                    return false; // パースに時間がかかり過ぎているなら諦める。
                }
            }
            let args = lines[i].trim().split("\t");
            this.parseCommand(args, i);
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

    parseCommand(args, lineIdx){


        let id = parseInt(args[1]);

        /** @type {Op}  */
        let op = null;
        if (id in this.opCache_) {
            op = this.opCache_[id][0];
        }
        
        let cmd = args[0];
        if (cmd.match(/^(L|S|E|R|W)$/) && op == null) {
            // error
        }

        switch(cmd) {

        case "C": 
            // 前回ログ出力時からの経過サイクル数を指定
            // フォーマット
            //      C	<CYCLE>
            // <CYCLE>: 経過サイクル数
            this.curCycle += parseInt(args[1]);
            break;
        
        case "I": 
            // 特定の命令に関するコマンド出力の開始
            // 使用例：
            //      I	0	0	0
            // * 命令に関するコマンドを出力する前にこれが必要
            //      ファイル内に新しい命令が初めて現れた際に出力
            // * 2列目はファイル内の一意のID
            //      ファイル内で現れるたびに振られるシーケンシャルなID
            //      基本的に他のコマンドは全てこのIDを使って命令を指定する
            // * 3列目は命令のID
            //      シミュレータ内で命令に振られているID．任意のIDが使える
            // * 4列目はTID（スレッド識別子）
            op = new this.Op();
            op.id = id;
            op.gid = args[2];
            op.tid = args[3];
            op.fetchedCycle = this.curCycle;
            op.line = lineIdx;
            this.opCache_[id] = [op, lineIdx];
            if (this.lastID_ < id) {
                this.lastID_ = id;
            }
            break;

        case "L": {
            // * 命令に任意のラベルをつける
            //      * 命令が生きている期間は任意のラベルをつけることができる
            //      * Lが複数回実行された場合，前回までに設定したラベルに追記される
            // フォーマット:
            //    L 	<ID>	<Type>	<Label Data>
            //
            // <ID>: ファイル内の一意のID
            // <Type>: ラベルのタイプ
            //      0: ビジュアライザ左に直接表示されるラベル．通常はPCと命令，レジスタ番号など
            //      1: マウスオーバー時に表示される詳細．実行時のレジスタの値や使用した演算器など
            //      2: 現在のステージにつけられるラベル
            // <Label Data>: 任意のテキスト
            let type = parseInt(args[2]);
            if (type == 0) {
                op.labelName += args[3];
            }
            else if (type == 1) {
                op.labelDetail += args[3];
            }
            else if (type == 2) {
                op.labelStage[op.lastParsedStage] += args[3];
            }
            
            break;
        }

        case "S": {
            let laneName = args[2];
            let stageName = args[3];
            let stage = new this.Stage({name:stageName, startCycle:this.curCycle});
            if (op.lanes[laneName] == null) {
                op.lanes[laneName] = [];
            }
            //var lane = op.lanes[laneName];
            op.lanes[laneName].push(stage);
            op.lastParsedStage = stageName;
            break;
        }

        case "E": {
            let laneName = args[2];
            let stageName = args[3];
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
            op.rid = args[2];
            op.retiredCycle = this.curCycle;
            if (parseInt(args[3]) == 1) {
                op.flush = true;
            }
            break;
        }

        case "W": {
            // 任意の依存関係 - 典型的にはウェイクアップ
            // タイプ番号の指定により，違う色で表示される
            //
            // フォーマット:
            //      W	<Consumer ID>	<Producer ID>	<Type>
            //
            // <Consumer ID>: 2列目はコンシューマーのID
            // <Producer ID>: 3列目はプロデューサーのID
            // <Type>: 4列目は依存関係のタイプ
            //      0ならウェイクアップ, 1以降は今のところ予約
            //      コンシューマーが生きている期間のみ使用可能

            let prodId = Number(args[2]);
            let type = Number(args[3]);
            op.prods.push(
                {id: prodId, type: type, cycle: this.curCycle}
            );
            this.opCache_[prodId][0].cons.push(
                {id: id, type: type, cycle: this.curCycle}
            );
            break;
        }
        }  // switch end
    }
}

module.exports.OnikiriParser = OnikiriParser;
