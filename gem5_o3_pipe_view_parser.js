let Op = require("./op").Op;
let Stage = require("./stage").Stage;

class Gem5O3PipeViewParser{

    constructor(){

        // ファイルリーダ
        this.file_ = null; 

        // Callback handlers on update, finish, and error
        this.updateCallback_ = null;
        this.finishCallback_ = null;
        this.errorCallback_ = null;

        // 現在の行番号
        this.curLine_ = 1;

        // 現在読み出し中の ID/サイクル
        this.curCycle_ = 0;

        // 最後に読み出された命令の ID
        this.lastID_ = 0;
        this.lastRID_ = 0;
        this.lastSeqNum_ = 0;

        // seq_num, flush flag, and tick for a currently parsed instruciton
        this.curParsingSeqNum_ = 0;
        this.curParsingInsnFlushed_ = false;   // seq_num 
        this.curParsingInsnCycle_ = -1;         // This is used when insturuction is flushed
        
        // パースが終了した op のリスト
        /** @type {Op[]} */
        this.opList_ = [];

        /** @type {Op} */
        this.retiredOpList_ = [];

        // パース中の op のリスト
        // ファイル内の op の順序はほぼランダムなため，一回ここに貯めたあと
        // 再度 id と rid の割り付ける
        /** @type {Object.<number, Op>} */
        this.parsingOpList_ = {};
        
        // パース完了
        this.complete_ = false;

        // 出現したレーンのマップ
        this.laneMap_ = {};

        // ステージの出現順序を記録するマップ
        this.stageLevelMap_ = {};

        // 読み出し開始時間
        this.startTime_ = 0;

        // 更新間隔のタイマ
        this.updateTimer_ = 100;    // 初回は100行読んだら1回表示するようにしとく

        // 更新ハンドラの呼び出し回数
        this.updateCount_ = 0;    

        // 強制終了
        this.closed_ = false;

        // ticks(ps) per clock in GEM5. 
        // The default value is 1000 (1000 ps = 1 clock in 1GHz)
        this.ticks_per_clock_ = -1;

        // Stage ID
        this.STAGE_ID_FETCH_ = 0;
        this.STAGE_ID_DECODE_ = 1;
        this.STAGE_ID_RENAME_ = 2;
        this.STAGE_ID_DISPATCH_ = 3;
        this.STAGE_ID_ISSUE_ = 4;
        this.STAGE_ID_COMPLETE_ = 5;
        this.STAGE_ID_RETIRE_ = 6;

        this.STAGE_ID_MAP_ = {
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
        // パージ
        this.opList_ = null;   
        this.parsingOpList_ = null;
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

    /** @returns {Op[]} */
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

    /** @returns {Op} */
    getOp(id){
        if (id > this.lastID_){
            return null;
        }
        else{
            return this.opList_[id];
        }
    }
    
    /** @returns {Op} */
    getOpFromRID(rid){
        if (rid > this.lastRID_){
            return null;
        }
        else{
            return this.retiredOpList_[rid];
        }
    }

    /** @returns {number} */
    get lastID(){
        return this.lastID_;
    }

    /** @returns {number} */
    get lastRID(){
        return this.lastRID_;
    }

    /** @returns {Object.<string, number>} */
    get laneMap(){
        return this.laneMap_;
    }

    /** @returns {Object.<string, number>} */
    get stageLevelMap(){
        return this.stageLevelMap_;
    }

    /** @returns {number} */
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

        // File format detection
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

            // Call update callback, which updates progress bars 
            this.updateCallback_(
                1.0 * this.file_.bytesRead / this.file_.fileSize,
                this.updateCount_
            );
            this.updateCount_++;

            this.drainParsingOps_(false);
        }
    }

    detectTicksPerClock(force){
        if (this.ticks_per_clock_ != -1) {
            return;
        }

        // Collect all outputted ticks
        let ticks = {};
        for (let seqNum in this.parsingOpList_) {

            let op = this.parsingOpList_[seqNum];
            if (!op.flush && !op.retired) {
                break;  // A next op has not been parsed yet.
            }

            ticks[op.fetchedCycle] = 1;
            ticks[op.retiredCycle] = 1;
            for (let laneID in op.lanes) {
                let lane = op.lanes[laneID];
                for (let stage of lane.stages) {
                    ticks[stage.startCycle] = 1;
                    ticks[stage.endCycle] = 1;
                }
            }
        }

        // If there is not enough ticks, detection is not performed.
        if (!force && ticks.length < 1024) {
            return;
        }

        // Sort as numbers
        let rawTicks = [];
        for (let i of Object.keys(ticks)) {
            rawTicks.push(Number(i));
        }
        let sortedTicks = rawTicks.sort((a, b) => {return a - b;});

        // Detect minimum delta
        let minDelta = 0;
        let prevTick = sortedTicks[0]; 
        for (let i of sortedTicks) {
            let delta = i - prevTick;
            if (minDelta == 0 || (delta > 0 && delta < minDelta)) {
                minDelta = delta;
            }
            prevTick = i;
        }

        if (minDelta > 0) {
            this.ticks_per_clock_ = minDelta;
            console.log("Detected ticks per clock: " + minDelta);
        }
    }

    // Update opList from parsingOpList
    drainParsingOps_(force){
        this.detectTicksPerClock(force);

        // Get sorted sequence numbers
        let rawSeqNums = [];
        for (let i in this.parsingOpList_) {
            rawSeqNums.push(Number(i));
        }
        let sortedSeqNums = rawSeqNums.sort((a, b) => {return a - b;});


        let nextID = this.opList_.length;
        let flushingNum = 0;
        for (let seqNum of sortedSeqNums) {
            let nextSeqNum = this.lastSeqNum_ + 1;
            // Since seqNum is occasionally added 2, +1 must be checked.
            if (!force && nextSeqNum != seqNum && nextSeqNum + 1 != seqNum) {
                break;  // A next op has not been parsed yet.
            }

            let op = this.parsingOpList_[seqNum];
            if (!op.flush && !op.retired) {
                break;  // A next op has not been parsed yet.
            }

            // Add an op to opList and remove it from parsingOpList
            this.opList_[nextID] = op;
            delete this.parsingOpList_[seqNum];
            this.lastSeqNum_ = seqNum;

            // Update IDs
            op.id = nextID;
            nextID++;

            if (!op.flush) {
                op.rid = this.lastRID_;
                this.retiredOpList_[op.rid] = op;
                this.lastRID_++;
                flushingNum = 0;
            }
            else { // in a flushing phase
                op.rid = this.lastRID_ + flushingNum;
                flushingNum++;
            }

            // Update clock cycles
            op.fetchedCycle /= this.ticks_per_clock_;
            op.retiredCycle /= this.ticks_per_clock_;
            op.prodCycle /= this.ticks_per_clock_;
            op.consCycle /= this.ticks_per_clock_;
            for (let laneID in op.lanes) {
                let lane = op.lanes[laneID];
                for (let stage of lane.stages) {
                    stage.startCycle /= this.ticks_per_clock_;
                    stage.endCycle /= this.ticks_per_clock_;
                }
            }
        } 
        this.lastID_ = this.opList_.length - 1;
        //this.curCycle_ = this.opList_[this.lastID_].retiredCycle;
    }

    finishParsing() {
        if (this.closed_) {
            return;
        }

        
        // リタイア処理が行われなかった終端部分の後処理
        //this.drainParsingOps_(true);

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

    /** @param {Op} op */
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

    /** @param {string[]} args */
    parseInitialCommand(args){
        // 特定の命令に関するコマンド出力の開始
        // O3PipeView:fetch:2132747000:0x004ea8f4:0:4:  add   w6, w6, w7

        let tick = Number(args[2]);
        let insnAddr = args[3];
        //let microPC = Number(args[4]);
        let seqNum = Number(args[5]);
        let disasm = args[6];

        let op = new Op();
        op.id = -1; // ここではまだ決定しない
        op.gid = seqNum;
        op.tid = 0;
        op.fetchedCycle = tick;
        op.line = this.curLine_;
        op.labelName += `${insnAddr}: ${disasm}`;
        this.parsingOpList_[seqNum] = op;

        // Reset the currenct context
        this.curParsingSeqNum_ = seqNum;
        this.curParsingInsnFlushed_ = false;
        this.curParsingInsnCycle_ = op.fetchedCycle;

        this.parseStartCommand(seqNum, op, args);
    }

    parseStartCommand(seqNum, op, args){
        // O3PipeView:fetch:2132747000:0x004ea8f4:0:4:  add   w6, w6, w7
        // O3PipeView:decode:2132807000
        let cmd = args[1];
        let tick = Number(args[2]);
        let stageID = this.STAGE_ID_MAP_[cmd];
        let stageName = this.STAGE_LABEL_MAP_[stageID];

        //if (seqNum == 7) {
        //    seqNum = seqNum;
        //}

        // If tick is 0, this op is flushed.
        if (tick == 0) {
            //op.flush = true;
            this.curParsingInsnFlushed_ = true;
            tick = this.curParsingInsnCycle_; // Set the last valid tick
        }
        else {
            this.curParsingInsnCycle_ = tick;
        }

        let laneName = "0"; // Default lane
        let stage = new Stage();

        stage.name = stageName;
        stage.startCycle = tick;
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

    parseEndCommand(seqNum, op, args){
        let tick = Number(args[2]);
        let laneName = "0"; // Default lane
        let stageName = op.lastParsedStage;

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
        stage.endCycle = tick;

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

    parseRetireCommand(seqNum, op, args){
        //if (seqNum == 7) {
        //    seqNum = seqNum;
        //}

        let tick = Number(args[2]);
        // If tick is 0, this op is flushed.
        if (tick == 0) {
            this.curParsingInsnFlushed_ = true;
            tick = this.curParsingInsnCycle_; // Set the last valid tick
        }
        op.retiredCycle = tick;

        if (this.curParsingInsnFlushed_) {
            op.flush = true;
            op.retired = false;
        }
        else{
            op.flush = false;
            op.retired = true;
        }

        // Decode label strings
        this.unescpaeLabels(op);

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

    parseCommand(args){

        let seqNum = this.curParsingSeqNum_;

        /** @type {Op}  */
        let op = null;
        if (seqNum in this.parsingOpList_) {
            op = this.parsingOpList_[seqNum];
        }
        
        let cmd = args[1];

        switch(cmd) {

        
        case "fetch": 
            this.parseInitialCommand(args);
            break;
        case "decode": 
        case "rename": 
        case "dispatch": 
        case "issue": 
        case "complete": 
            this.parseEndCommand(seqNum, op, args);
            this.parseStartCommand(seqNum, op, args);
            break;
        case "retire": 
            this.parseRetireCommand(seqNum, op, args);
            break;
        }  // switch end
    }
}

module.exports.Gem5O3PipeViewParser = Gem5O3PipeViewParser;
