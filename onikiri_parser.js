let Op = require("./op").Op;
let Stage = require("./stage").Stage;

class OnikiriParser{

    constructor(){

        // ファイルリーダ
        this.file_ = null; 

        // Callback handlers on update, finish, and error
        this.updateCallback_ = null;
        this.finishCallback_ = null;
        this.errorCallback_ = null;

        // 現在の行番号
        this.curLine_ = 1;

        // 現在読み出し中のサイクル
        this.curCycle_ = 0;

        // 最後に読み出された命令の ID
        this.lastID_ = -1;
        this.lastRID_ = -1;
        
        // op 情報
        this.opList_ = [];
        this.retiredOpList_ = [];
    
        // パース完了
        this.complete_ = false;

        // 出現したレーンのマップ
        this.laneMap_ = {};

        // ステージの出現順序を記録するマップ
        this.stageLevelMap_ = {};

        // 読み出し開始時間
        this.startTime_ = 0;

        // 更新間隔のタイマ
        this.updateTimer_ = 100;    // 100行読んだら1回表示するようにしとく

        // 更新ハンドラの呼び出し回数
        this.updateCount_ = 0;    

        // 強制終了
        this.closed_ = false;
    }
    
    // Public methods

    // 閉じる
    close(){
        this.closed_ = true;
        this.opList_ = null;   // パージ
    }

    /**
     * @return {string} パーサーの名前を返す
     */
    get name(){
        return "OnikiriParser";
    }

    // updateCallback(percent, count): 読み出し状況を 0 から 1.0 で渡す．count は呼び出し回数
    setFile(file, updateCallback, finishCallback, errorCallback){
        this.file_ = file;
        this.updateCallback_ = updateCallback;
        this.finishCallback_ = finishCallback;
        this.errorCallback_ = errorCallback;
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
            return this.opList_[id];
        }
    }
    
    getOpFromRID(rid){
        if (rid > this.lastRID_){
            return null;
        }
        else{
            return this.retiredOpList_[rid];
        }
    }

    get lastID(){
        return this.lastID_;
    }

    get lastRID(){
        return this.lastRID_;
    }

    get laneMap(){
        return this.laneMap_;
    }

    get stageLevelMap(){
        return this.stageLevelMap_;
    }

    get lastCycle(){
        return this.curCycle_;
    }

    startParsing(){
        this.complete_ = false;
        this.curCycle_ = 0;
    }

    /**
     * @param {string} line 
     */
    parseLine(line){
        if (this.closed_) {
            // Node.js はファイル読み出しが中断されクローズされた後も，
            // バッファにたまっている分はコールバック読み出しを行うため，
            // きちんと無視する必要がある
            return;
        }
        if (this.curLine_ == 1) {
            if (!line.match(/^Kanata/)) {   // This file is not Kanata log.
                this.errorCallback_();
                return;
            }
        }

        let args = line.split("\t");
        this.parseCommand(args);
        this.curLine_++;
        
        this.updateTimer_--;
        if (this.updateTimer_ < 0) {
            this.updateTimer_ = 1024*32;
            this.updateCallback_(
                1.0 * this.file_.bytesRead / this.file_.fileSize,
                this.updateCount_
            );
            this.updateCount_++;
        }
    }

    finishParsing() {
        if (this.closed_) {
            return;
        }
        
        // 鬼斬側でリタイア処理が行われなかった終端部分の後処理
        let i = this.opList_.length - 1;
        while (i >= 0) {
            let op = this.opList_[i];
            if (op.retired && !op.flush) {
                break; // コミットされた命令がきたら終了
            }
            i--;
            if (op.flush) {
                continue; // フラッシュされた命令には特になにもしない
            }
            op.retiredCycle = this.curCycle_;
            op.eof = true;
            this.unescpaeLabels(op);
        }
        this.lastID_ = this.opList_.length - 1;
        this.complete_ = true;

        let elapsed = ((new Date()).getTime() - this.startTime_);

        this.updateCallback_(1.0, this.updateCount_);
        this.finishCallback_();
        console.log(`Parsed (${this.name}): ${elapsed} ms`);
    }

    unescpaeLabels(op){
        // op 内のラベルのエスケープされている \n を戻す
        // v8 エンジンでは，文字列を結合すると cons 文字列という形式で
        // 文字列のリストとして保持するが，これはメモリ効率が悪いが，
        // 正規表現をかけるとそれが平坦化されるのでメモリ効率もあがる
        // （op 1つあたり 2KB ぐらいメモリ使用量が減る
        op.labelName = op.labelName.replace(/\\n/g, "\n");
        op.labelDetail = op.labelDetail.replace(/\\n/g, "\n");
        for (let laneName in op.lanes) {
            for (let stage of op.lanes[laneName].stages) {
                for (let i = 0; i < stage.labels.length; i++) {
                    stage.labels[i] = stage.labels[i].replace(/\\n/g, "\n");
                }
            }
        }

    }

    parseInitialCommand(id, op, args){
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
        op = new Op();
        op.id = id;
        op.gid = Number(args[2]);
        op.tid = Number(args[3]);
        op.fetchedCycle = this.curCycle_;
        op.line = this.curLine_;
        this.opList_[id] = op;
    }

    /** 
     * @param {number} id 
     * @param {Op} op
     * @param {string[]} args
     * */
    parseLabelCommand(id, op, args){
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
        let type = Number(args[2]);

        let str = args[3];

        if (type == 0) {
            op.labelName += str;
        }
        else if (type == 1) {
            op.labelDetail += str;
        }
        else if (type == 2) {
            op.lastParsedStage.labels.push(str);
        }
    }

    /** 
     * @param {number} id 
     * @param {Op} op
     * @param {string[]} args
     * */
    parseStartCommand(id, op, args){
        let laneName = args[2];
        let stageName = args[3];
        let stage = new Stage();
        stage.name = stageName;
        stage.startCycle = this.curCycle_;
        if (!(laneName in op.lanes)) {
            op.lanes[laneName] = {
                level: 0,  // 1サイクル以上のステージの数
                stages: [],
            };
        }

        let laneInfo = op.lanes[laneName];
        laneInfo.stages.push(stage);
        op.lastParsedStage = stage;

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
        if (stageName in map) {
            if (map[stageName] > laneInfo.level) {
                map[stageName] = laneInfo.level;
            }
        }
        else{
            map[stageName] = laneInfo.level;
        }
    }

    parseEndCommand(id, op, args){
        let laneName = args[2];
        let stageName = args[3];
        let stage = null;
        let laneInfo = op.lanes[laneName];
        let lane = laneInfo.stages;
        for (let i = lane.length - 1; i >= 0; i--) {
            if (lane[i].name == stageName) {
                stage = lane[i];
                break;
            }
        }
        if (stage == null) {
            return;
        }
        stage.endCycle = this.curCycle_;

        // レベルの更新
        // フラッシュで無理矢理閉じられることがあるので，
        // stageNameMap への登録はここでやってはいけない．
        if (stage.startCycle != stage.endCycle) {
            laneInfo.level++;
        }

        // X を名前に含むステージは実行ステージと見なす
        if (stageName.match(/X/)){
            op.prodCycle = this.curCycle_ - 1;
        }
    }

    parseRetireCommand(id, op, args){
        op.rid = Number(args[2]);
        op.retiredCycle = this.curCycle_;
        if (Number(args[3]) == 1) {
            op.flush = true;
            op.retired = false;
        }
        else{
            op.flush = false;
            op.retired = true;
        }
        if (this.lastID_ < id) {
            this.lastID_ = id;
        }
        this.unescpaeLabels(op);

        if (!op.flush) {
            this.retiredOpList_[op.rid] = op;
            if (this.lastRID_ < op.rid) {
                this.lastRID_ = op.rid;
            }
        }

        // 閉じていないステージがあった場合はここで閉じる
        for (let laneName in op.lanes) {
            let stages = op.lanes[laneName].stages;
            if (stages.length > 0) {
                let stage = stages[stages.length - 1];
                if (stage.endCycle == 0) {
                    stage.endCycle = this.curCycle_;
                }
            }
        }
    }

    parseDependencyCommand(id, op, args){
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
        let prod = this.opList_[prodId];
        let type = Number(args[3]);
        op.prods.push(
            {op: prod, type: type, cycle: this.curCycle_}
        );
        prod.cons.push(
            {op: op, type: type, cycle: this.curCycle_}
        );
    }

    parseCommand(args){

        let id = Number(args[1]);

        let op = null;
        if (id in this.opList_) {
            op = this.opList_[id];
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
            this.curCycle_ += Number(args[1]);
            break;
        
        case "I": 
            this.parseInitialCommand(id, op, args);
            break;

        case "L":
            this.parseLabelCommand(id, op, args);
            break;

        case "S": 
            this.parseStartCommand(id, op, args);
            break;

        case "E": 
            this.parseEndCommand(id, op, args);
            break;

        case "R": 
            this.parseRetireCommand(id, op, args);
            break;

        case "W": 
            this.parseDependencyCommand(id, op, args);
            break;
        }  // switch end
    }
}

module.exports.OnikiriParser = OnikiriParser;
