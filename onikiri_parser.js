class OnikiriParser{

    constructor(){
        this.Op = require("./op").Op;
        this.Stage = require("./stage").Stage;

        // ファイルリーダ
        this.file_ = null; 

        // 更新通知のコールバック
        this.updateCallback_ = null;

        // 現在の行番号
        this.curLine_ = 1;

        // 現在読み出し中のサイクル
        this.curCycle_ = 0;

        // 最後に読み出された命令の ID
        this.lastID_ = -1;
        
        // op情報のキャッシュ（配列）
        this.opCache_ = [];
    
        // パース完了
        this.complete_ = false;

        // 出現したレーンのマップ
        this.laneMap_ = {};

        // ステージの出現順序を記録するマップ
        this.stageLevelMap_ = {};

        // 読み出し開始時間
        this.startTime_ = 0;

        // 更新間隔
        this.updateCount_ = 100;    // 100行読んだら1回表示するようにしとく
    }
    
    // Public methods
    getName(){
        return "OnikiriParser:(" + this.file_.getPath() + ")";
    }

    setFile(file, updateCallback){
        this.file_ = file;
        this.updateCallback_ = updateCallback;
        this.startTime_ = (new Date()).getTime();

        this.startParsing();
        file.readlines(
            this.parseLine.bind(this), 
            this.finishParsing.bind(this)
        );
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
        if (id > this.lastID_){
            return null;
        }
        else{
            return this.opCache_[id];
        }
    }
    
    getOpFromRID(rid){
        let cache = this.opCache_;
        for (let i = this.lastID_; i >= 0; i--) {
            if (cache[i] && cache[i].rid == rid) {
                return cache[i];
            }
        }
        return null;
    }

    get lastID(){
        return this.lastID_;
    }

    get laneMap(){
        return this.laneMap_;
    }

    get stageLevelMap(){
        return this.stageLevelMap_;
    }

    startParsing(){
        this.complete_ = false;
        this.curCycle_ = 0;
    }

    parseLine(line){
        let args = line.split("\t");
        this.parseCommand(args);
        this.curLine_++;

        this.updateCount_--;
        if (this.updateCount_ < 0) {
            this.updateCount_ = 1024*256;
            this.updateCallback_();
        }
    }

    finishParsing() {
        // 鬼斬側でリタイア処理が行われなかった終端部分の後処理
        let i = this.opCache_.length - 1;
        while (i >= 0) {
            let op = this.opCache_[i];
            if (op.retired && !op.flush) {
                break; // コミットされた命令がきたら終了
            }
            i--;
            if (op.flush) {
                continue; // フラッシュされた命令には特になにもしない
            }
            op.retiredCycle = this.curCycle_;
            op.eof = true;
        }
        this.lastID_ = this.opCache_.length - 1;
        this.complete_ = true;

        let elapsed = ((new Date()).getTime() - this.startTime_);

        console.log(`parse complete (${elapsed} ms)`);
    }


    parseCommand(args){

        let id = parseInt(args[1]);

        /** @type {Op}  */
        let op = null;
        if (id in this.opCache_) {
            op = this.opCache_[id];
        }
        
        let cmd = args[0];
        /*
        if (cmd.match(/^(L|S|E|R|W)$/) && op == null) {
            // error
        }*/

        switch(cmd) {

        case "C": 
            // 前回ログ出力時からの経過サイクル数を指定
            // フォーマット
            //      C	<CYCLE>
            // <CYCLE>: 経過サイクル数
            this.curCycle_ += parseInt(args[1]);
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
            op.fetchedCycle = this.curCycle_;
            op.line = this.curLine_;
            this.opCache_[id] = op;
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

            // エスケープされている \n を戻す
            let str = args[3];
            str = str.replace(/\\n/g, "\n");

            if (type == 0) {
                op.labelName += str;
            }
            else if (type == 1) {
                op.labelDetail += str;
            }
            else if (type == 2) {
                if (op.lastParsedStage in op.labelStage){
                    op.labelStage[op.lastParsedStage] += str;
                }
                else{
                    op.labelStage[op.lastParsedStage] = str;
                }
            }
            
            break;
        }

        case "S": {
            let laneName = args[2];
            let stageName = args[3];
            let stage = new this.Stage();
            stage.name = stageName;
            stage.startCycle = this.curCycle_;
            if (!(laneName in op.lanes)) {
                op.lanes[laneName] = [];
            }

            op.lanes[laneName].push(stage);
            op.lastParsedStage = stageName;

            // X を名前に含むステージは実行ステージと見なす
            if (stageName.match(/X/)){
                op.consCycle = this.curCycle_;
            }

            // レーンのマップに登録
            if (!(laneName in this.laneMap_)) {
                this.laneMap_[laneName] = 1;
            }

            // ステージのマップに登録
            let map = this.stageLevelMap_;
            let lane = op.lanes[laneName];
            let level = -1;
            for (let s of lane) {
                if (s.startCycle != s.endCycle) {
                    level++;
                }
            }
            if (stageName in map) {
                if (map[stageName] > level) {
                    map[stageName] = level;
                }
            }
            else{
                map[stageName] = level;
            }

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
            stage.endCycle = this.curCycle_;

            // X を名前に含むステージは実行ステージと見なす
            if (stageName.match(/X/)){
                op.prodCycle = this.curCycle_ - 1;
            }
            break;
        }

        case "R": {
            op.retired = true;
            op.rid = args[2];
            op.retiredCycle = this.curCycle_;
            if (parseInt(args[3]) == 1) {
                op.flush = true;
            }
            if (this.lastID_ < id) {
                this.lastID_ = id;
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
                {id: prodId, type: type, cycle: this.curCycle_}
            );
            this.opCache_[prodId].cons.push(
                {id: id, type: type, cycle: this.curCycle_}
            );
            break;
        }
        }  // switch end
    }
}

module.exports.OnikiriParser = OnikiriParser;
