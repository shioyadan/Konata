class Gem5O3PipeViewParser{

    constructor(){
        this.Op = require("./op").Op;
        this.Stage = require("./stage").Stage;

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
        this.lastID_ = 0;
        this.lastRID_ = 0;
        
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

        // ticks(ps) per clock in GEM5. 
        // Its default value is 1000 (1000 ps = 1 clock in 1GHz)
        this.TICKS_PER_CLOCK_ = 1000;

        // Stage ID
        this.STAGE_ID_FETCH_ = 0;
        this.STAGE_ID_DECODE_ = 1;
        this.STAGE_ID_RENAME_ = 2;
        this.STAGE_ID_DISPATCH_ = 3;
        this.STAGE_ID_ISSUE_ = 4;
        this.STAGE_ID_COMPLETE_ = 5;
        this.STAGE_ID_RETIRE_ = 6;

        this.STAGE_ID_MAP = {
            "fetch": this.STAGE_ID_FETCH_,
            "decode": this.STAGE_ID_DECODE_,
            "rename": this.STAGE_ID_RENAME_,
            "dispatch": this.STAGE_ID_DISPATCH_,
            "issue": this.STAGE_ID_ISSUE_,
            "complete": this.STAGE_ID_COMPLETE_,
            "retire": this.STAGE_ID_RETIRE_
        };

        this.STAGE_LABEL_MAP_ = [
            "F",
            "Dc",
            "Rn",
            "Ds",
            "Is",
            "Cm",
            "Rt",
        ];
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
        return "Gem5O3PipeViewParser";
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
            if (!line.match(/^O3PipeView/)) {   // This file is not O3PipeView.
                this.errorCallback_();
                return;
            }
        }

        let args = line.split(":");
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
        
        // リタイア処理が行われなかった終端部分の後処理
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
        for (let i in op.labelStage) {
            op.labelStage[i] = op.labelStage[i].replace(/\\n/g, "\n");
        }

    }

    parseInitialCommand(id, op, args){
        // 特定の命令に関するコマンド出力の開始
        // O3PipeView:fetch:2132747000:0x004ea8f4:0:4:  add   w6, w6, w7

        let tick = Number(args[2]);
        let insnAddr = Number(args[3]);
        //let microPC = Number(args[4]);
        //let seqNum = Number(args[5]);
        let disasm = Number(args[6]);

        op = new this.Op();
        op.id = id;
        op.gid = 0;
        op.tid = 0;
        op.fetchedCycle = tick / this.TICKS_PER_CLOCK_;
        op.line = this.curLine_;
        op.labelName += `${insnAddr}: ${disasm}`;
        this.opList_[id] = op;
    }

    parseStartCommand(id, op, args){
        // O3PipeView:fetch:2132747000:0x004ea8f4:0:4:  add   w6, w6, w7
        let stageName = this.STAGE_LABEL_MAP_[this.STAGE_ID_MAP_[args[1]]];
        let tick = Number(args[2]);

        let laneName = "0"; // Default lane
        let stage = new this.Stage();

        stage.name = stageName;
        stage.startCycle = tick / this.TICKS_PER_CLOCK_;
        if (!(laneName in op.lanes)) {
            op.lanes[laneName] = {
                level: 0,  // 1サイクル以上のステージの数
                stages: [],
            };
        }

        let laneInfo = op.lanes[laneName];
        laneInfo.stages.push(stage);
        op.lastParsedStage = stageName;

        // X を名前に含むステージは実行ステージと見なす
        //if (stageName.match(/X/)){
        //    op.consCycle = this.curCycle_;
        //}

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
        let type = Number(args[3]);
        op.prods.push(
            {id: prodId, type: type, cycle: this.curCycle_}
        );
        this.opList_[prodId].cons.push(
            {id: id, type: type, cycle: this.curCycle_}
        );
    }

    parseCommand(args){

        let id = self.lastID_;

        /** @type {Op}  */
        let op = null;
        if (id in this.opList_) {
            op = this.opList_[id];
        }
        
        let cmd = args[1];

        switch(cmd) {

        
        case "fetch": 
            this.parseInitialCommand(id, op, args);
            break;
        /*
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
        */
        }  // switch end
    }
}

module.exports.Gem5O3PipeViewParser = Gem5O3PipeViewParser;
