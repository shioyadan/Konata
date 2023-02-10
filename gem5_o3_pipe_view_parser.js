let Op = require("./op").Op;
let OpList = require("./op_list").OpList;
let {ParsingOpList} = require("./op_list");
let Dependency = require("./op").Dependency;
let Stage = require("./stage").Stage;
let StageLevelMap = require("./stage").StageLevelMap;
let Lane = require("./stage").Lane;

// To avoid conflicts with node.js internal FileReader, use a different name.
let InternalFileReader = require("./file_reader").FileReader; // eslint-disable-line

class Gem5O3PipeViewExLogInfo{
    constructor(){
        /** @type {string[][]} */
        this.logList = [];

        this.srcs = [];
        this.dsts = [];
    }
}

class Gem5O3PipeViewParser{

    constructor(){

        // ファイルリーダ
        /** @type {InternalFileReader} */
        this.file_ = null; 

        // Callback handlers on update, finish, and error
        this.updateCallback_ = null;
        this.finishCallback_ = null;
        this.errorCallback_ = null;

        // 現在の行番号
        this.curLine_ = 1;

        // 現在読み出し中の ID/サイクル
        this.curCycle_ = 0;

        // Op のリスト 
        /** @type {OpList} */
        this.opListBody_ = new OpList();

        /** @type {ParsingOpList} */
        this.secondParsingOpList_ = new ParsingOpList();

        /** @type {number} - 最後に読み出された命令の ID*/
        this.lastGID_ = -1;  // seqNum
        this.lastNotFlushedID = -1; // 最後に正常にリタイアした命令の id

        // seq_num, flush flag, and tick for a currently parsed instruction
        this.curParsingSeqNum_ = 0;
        this.curParsingInsnFlushed_ = false;   // seq_num 
        this.curParsingInsnCycle_ = -1;         // This is used when instruction is flushed

        // パース中の op のリスト
        // ファイル内の op の順序はほぼランダムなため，一回ここに貯めたあと
        // 再度 id と rid の割り付ける
        // こいつは連続していないので，辞書になっている
        /** @type {Object.<string, Op>} */
        this.parsingOpList_ = {};

        // パース中の O3PipeView 以外のログ
        /** @type {Object.<string, Gem5O3PipeViewExLogInfo>} */
        this.parsingExLog_ = {};

        // O3PipeView 以外のログで最後に現れた SN
        this.parsingExLogLastGID_ = -1;

        // A table for dependency tracking
        /** @type {Object.<string, Op>} */
        this.depTable_ = {};
        
        // パース完了
        this.complete_ = false;

        // 出現したレーンのマップ
        this.laneMap_ = {};

        // ステージの出現順序を記録するマップ
        this.stageLevelMap_ = new StageLevelMap();

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

        // 開始時の tick
        this.cycle_begin_ = -1;

        // 開始時の GID (seq number)
        this.gidBegin_ = -1;

        // O3PipeView のタグが現れたかどうか
        this.isGem5O3PipeView = false;

        // この行数までに O3PipeView のタグが現れなかったら諦める
        this.GIVING_UP_LINE = 20000;

        // Stage ID
        this.STAGE_ID_FETCH_ = 0;
        this.STAGE_ID_DECODE_ = 1;
        this.STAGE_ID_RENAME_ = 2;
        this.STAGE_ID_DISPATCH_ = 3;
        this.STAGE_ID_ISSUE_ = 4;
        this.STAGE_ID_COMPLETE_ = 5;
        this.STAGE_ID_RETIRE_ = 6;
        this.STAGE_ID_MEM_COMPLETE_ = 7;

        this.STAGE_ID_MAP_ = {
            "fetch": this.STAGE_ID_FETCH_,
            "decode": this.STAGE_ID_DECODE_,
            "rename": this.STAGE_ID_RENAME_,
            "dispatch": this.STAGE_ID_DISPATCH_,
            "issue": this.STAGE_ID_ISSUE_,
            "complete": this.STAGE_ID_COMPLETE_,
            "retire": this.STAGE_ID_RETIRE_,
            "mem_complete": this.STAGE_ID_MEM_COMPLETE_   // 追加ログの解析結果より追加
        };

        this.STAGE_LABEL_MAP_ = [
            "F",
            "Dc",
            "Rn",
            "Ds",
            "Is",
            "Cm",
            "Rt",
            "Mc",
        ];

        this.SERIAL_NUMBER_PATTERN = new RegExp("sn:(\\d+)");
    }
    
    // Public methods

    // 閉じる
    close(){
        this.closed_ = true;
        this.opListBody_.close();
        // パージ
        this.parsingOpList_ = {};
        this.parsingExLog_ = {};
        this.depTable_ = {};
        this.laneMap_ = {};
    }

    /**
     * @return {string} パーサーの名前を返す
     */
    get name(){
        return "Gem5O3PipeViewParser";
    }

    /**
     * @param {InternalFileReader} file - ファイルリーダ
     * @param {function} updateCallback - 
     *      (percent, count): 読み出し状況を 0 から 1.0 で渡す．count は呼び出し回数
     * @param {function} finishCallback - 終了時に呼び出される
     * @param {function} errorCallback - エラー時に呼び出される
     */
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

    getOp(id, resolution=0){
        return this.opListBody_.getParsedOp(id, resolution);
    }
    
    getOpFromRID(rid, resolution=0){
        return this.opListBody_.getParsedOpFromRID(rid, resolution);
    }

    get lastID(){
        return this.opListBody_.parsedLastID;
    }

    get lastRID(){
        return this.opListBody_.parsedLastRID;
    }

    /** @returns {Object.<string, number>} */
    get laneMap(){
        return this.laneMap_;
    }

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

        let args = line.split(":");

        // File format detection
        if (args[0] != "O3PipeView") {
            this.curLine_++;
            if (!this.isGem5O3PipeView && this.curLine_ > this.GIVING_UP_LINE) {
                this.errorCallback_();
            }

            // O3PipeView 以外のログで sn:数字 の形式を持っている行は一旦 parsingLog_ に保持
            let sn = this.parsingExLogLastGID_;
            let matched = this.SERIAL_NUMBER_PATTERN.exec(line);
            if (matched) {
                sn = Number(matched[1]);
                this.parsingExLogLastGID_ = sn;
            }
            if (this.parsingExLogLastGID_ == -1 || sn <= this.opListBody_.parsedLastID) {   // 既にドレインされたものは諦める
                //console.log("Drop a drained op");
            }
            else {
                if (!(sn in this.parsingExLog_)) {
                    this.parsingExLog_[sn] = new Gem5O3PipeViewExLogInfo();
                }
                if (args[0].match(/^\s*\d+/)) { // 先頭に tick があるものだけ保存
                    this.parsingExLog_[sn].logList.push(args);
                }
                else{
                    this.parsingExLogLastGID_ = -1;
                }
            }
        }
        else {
            this.isGem5O3PipeView = true;
            this.parseCommand(args);
            this.curLine_++;
        }

        this.updateTimer_--;
        if (this.updateTimer_ < 0) {
            this.updateTimer_ = 1024*16;

            // Call update callback, which updates progress bars 
            this.updateCallback_(
                1.0 * this.file_.bytesRead / this.file_.fileSize,
                this.updateCount_
            );
            this.updateCount_++;

            if (this.isGem5O3PipeView) {
                this.drainParsingOps_(false);
            }
        }
    }

    detectTicksPerClock(force){
        if (this.ticks_per_clock_ != -1) {
            return;
        }

        // Collect all outputted ticks
        let ticks = {};
        let minSeqNum = -1; 
        for (let seqNumStr in this.parsingOpList_) {
            let seqNum = Number(seqNumStr);
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
                    //if (stage.endCycle == 0 || stage.startCycle == 0)
                    //    lane = lane;
                }
            }
            if (minSeqNum == -1 || minSeqNum > seqNum) {
                minSeqNum = seqNum;
            }
        }

        // Sort as numbers
        let rawTicks = [];
        for (let i of Object.keys(ticks)) {
            rawTicks.push(Number(i));
        }
        let sortedTicks = rawTicks.sort((a, b) => {return a - b;});

        // If there is not enough ticks, detection is not performed.
        if (!force && sortedTicks.length < 1024) {
            return;
        }

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
            this.cycle_begin_ = sortedTicks[0] / this.ticks_per_clock_;
            this.gidBegin_ = minSeqNum;
            console.log("Detected ticks per clock: " + minDelta);
        }
    }

    // Update opList from parsingOpList
    /** @param {boolean} force */
    drainParsingOps_(force){
        this.detectTicksPerClock(force);
        if (this.ticks_per_clock_ == -1) {
            return;
        }

        // GEM5 の O3PipeView はかなり out-of-order に出力されるので，
        // バッファしておく（1万以上平気で seq num がさかのぼることがある）
        let BUFFERED_SIZE = 1024*16;
        let seqNumList = Object.keys(this.parsingOpList_).sort((a, b) => {return Number(a) - Number(b);});
        let drainCount = seqNumList.length - BUFFERED_SIZE;
        if (!force &&  drainCount < 0) {
            return;
        }

        for (let seqNumStr of seqNumList) {

            let op = this.parsingOpList_[seqNumStr];
            if (!force && !op.flush && !op.retired) {
                continue;  // This op has not been parsed yet.
            }
            if (!force && drainCount <= 0) {
                break;
            }
            drainCount--;

            let seqNum = Number(seqNumStr); // Object 型からは文字列のみがでてくる

    
            // Update clock cycles
            op.fetchedCycle = op.fetchedCycle / this.ticks_per_clock_ - this.cycle_begin_;
            op.retiredCycle = op.retiredCycle / this.ticks_per_clock_ - this.cycle_begin_;
            // フェッチステージのみを実行したあとにフラッシュされると，
            // リタイアのサイクルが 0 → fetchedCycle と同じに設定されるため，
            // その場合に fetch を表示するために１つ遅らせる
            if (op.flush && op.fetchedCycle == op.retiredCycle) {
                op.retiredCycle++;
            }
            if (op.prodCycle != -1)
                op.prodCycle = op.prodCycle / this.ticks_per_clock_ - this.cycle_begin_;
            if (op.consCycle != -1)
                op.consCycle = op.consCycle / this.ticks_per_clock_ - this.cycle_begin_;

            for (let laneID in op.lanes) {
                let lane = op.lanes[laneID];
                for (let stage of lane.stages) {
                    stage.startCycle = stage.startCycle / this.ticks_per_clock_ - this.cycle_begin_;
                    stage.endCycle = stage.endCycle / this.ticks_per_clock_ - this.cycle_begin_;
                    // 特定のステージが開始されたあとにフラッシュされると，
                    // そのステージの終わりが 0 → startCycle と同じに設定されるため，
                    // その場合にそのステージを最低ひとつ表示するために１つ遅らせる
                    // つまりｓたとえば fetch:1000, decode:0 ときたときに，
                    // fetch が 1000->1000 となるので，これを 1000->1001 に書き換える
                    if (op.flush && stage.startCycle == stage.endCycle) {
                        stage.endCycle++;
                    }
                }
            }

            // Add an op to opList and remove it from parsingOpList.
            // At this time, op.id is not determined.
            this.secondParsingOpList_.setOp(seqNum - this.gidBegin_, op);
            delete this.parsingOpList_[seqNumStr];

            if (this.lastGID_ > seqNum) {
                console.log(`Miss parsed op: seqNum: ${seqNum} lastGID: ${this.lastGID_}. BUFFERED_SIZE must be bigger.`);
            }

        } 

        // GEM5 の O3PipeView はたまに out-of-order で出力されるので，
        // ある程度バッファしておく
        for (let i = this.opListBody_.parsedLastID + 1; i <= this.secondParsingOpList_.parsingLastID; i++) {
            let op = this.secondParsingOpList_.getParsingOp(i);
            if (op == null) {
                continue;
            }

            // op.id is determined
            op.id = i;
            this.secondParsingOpList_.purge(i);
            this.opListBody_.setOp(i, op);
            this.opListBody_.setParsedLastID(i);
            this.lastGID_ = op.gid;
            if (op.retiredCycle > this.curCycle_) {
                this.curCycle_ = op.retiredCycle;
            }

            if (!op.flush) {
                op.rid = this.opListBody_.parsedLastRID + 1;
                this.opListBody_.setParsedRetiredOp(op.rid, op);
                this.lastNotFlushedID = this.opListBody_.parsedLastID;
            }
            else { // in a flushing phase
                // Dummy RID
                op.rid = this.opListBody_.parsedLastRID + this.lastID - this.lastNotFlushedID;
            }

            // ExLog post process
            let seqNum = op.id + this.gidBegin_;
            if (seqNum in this.parsingExLog_) {
                let exLog = this.parsingExLog_[seqNum];
                for (let s of exLog.srcs) {
                    let type = 0; // default
                    if (s in this.depTable_) {
                        let prod = this.depTable_[s];
                        if (prod.prodCycle < op.consCycle) {
                            op.prods.push(new Dependency(prod.id, type, op.prodCycle));
                            prod.cons.push(new Dependency(op.id, type, op.consCycle));
                        }
                    }
                }
                //if (!op.flush) {
                for (let d of exLog.dsts) {
                    this.depTable_[d] = op;
                }
                delete this.parsingExLog_[seqNum];
            }


            this.opListBody_.setOp(i, op);
        }
    }

    finishParsing() {
        if (this.closed_) {
            return;
        }
        if (!this.isGem5O3PipeView) {
            this.errorCallback_();
            return;
        }

        // 未処理の命令を強制処理
        this.drainParsingOps_(true);
        
        // リタイア処理が行われなかった終端部分の後処理
        let i = this.secondParsingOpList_.parsingLastID;
        while (i >= 0) {
            let op = this.secondParsingOpList_.getParsingOp(i);
            i--;
            if (op == null) {
                continue;
            }
            if (op.retired && !op.flush) {
                break; // コミットされた命令がきたら終了
            }
            if (op.flush) {
                continue; // フラッシュされた命令には特になにもしない
            }
            op.retiredCycle = this.curParsingInsnCycle_ / this.ticks_per_clock_;
            op.eof = true;
            this.unescapeLabels(op);
            this.secondParsingOpList_.purge(i);
            this.opListBody_.setOp(i, op);
        }
        this.opListBody_.setParsedLastID(this.secondParsingOpList_.parsingLastID);
        this.complete_ = true;

        let elapsed = ((new Date()).getTime() - this.startTime_);

        this.updateCallback_(1.0, this.updateCount_);
        this.finishCallback_();

        // Release
        this.parsingOpList_ = {};
        this.parsingExLog_ = {};
        this.depTable_ = {};

        console.log(`Parsed (${this.name}): ${elapsed} ms`);
    }

    /** @param {Op} op */
    unescapeLabels(op){
        // op 内のラベルのエスケープされている \n を戻す
        // v8 エンジンでは，文字列を結合すると cons 文字列という形式で
        // 文字列のリストとして保持するが，これはメモリ効率が悪いが，
        // 正規表現をかけるとそれが平坦化されるのでメモリ効率もあがる
        // （op 1つあたり 2KB ぐらいメモリ使用量が減る
        op.labelName = op.labelName.replace(/\\n/g, "\n");
        op.labelDetail = op.labelDetail.replace(/\\n/g, "\n");
        for (let laneName in op.lanes) {
            for (let stage of op.lanes[laneName].stages) {
                stage.labels = stage.labels.replace(/\\n/g, "\n");
            }
        }
    }

    /** 
     * @param {string[]} args 
     * @return {Op}
    */
    parseInitialCommand(args){
        // 特定の命令に関するコマンド出力の開始
        // O3PipeView:fetch:2132747000:0x004ea8f4:0:4:  add   w6, w6, w7

        let tick = Number(args[2]);
        let insnAddr = args[3];
        //let microPC = Number(args[4]);
        let seqNum = Number(args[5]);
        let disasm = args[6];

        // Even if ":" is inserted after the 6th, it is disassembled text
        for (let i = 7; i < args.length; i++) {
            disasm += ":" + args[7];
        }

        let op = new Op();
        op.id = -1; // この段階ではまだ未定
        op.gid = seqNum;
        op.tid = 0;
        op.fetchedCycle = tick;
        op.line = this.curLine_;
        op.labelName += `${insnAddr}: ${disasm}`;
        op.labelDetail += `Fetched Tick: ${tick}`;
        this.parsingOpList_[seqNum] = op;

        // Reset the current context
        this.curParsingSeqNum_ = seqNum;
        this.curParsingInsnFlushed_ = false;
        this.curParsingInsnCycle_ = op.fetchedCycle;

        this.parseStartCommand(seqNum, op, args);

        return op;
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
            this.curParsingInsnFlushed_ = true;
            tick = this.curParsingInsnCycle_; // Set a last valid tick
            // Stages after flush are skipped.
            return;
        }
        else {
            this.curParsingInsnCycle_ = tick;
        }

        let laneName = "0"; // Default lane
        let stage = new Stage();

        stage.name = stageName;
        stage.startCycle = tick;
        if (!(laneName in op.lanes)) {
            op.lanes[laneName] = new Lane;
        }

        let laneInfo = op.lanes[laneName];
        laneInfo.stages.push(stage);
        op.lastParsedStage = stage;
        op.lastParsedCycle = tick;

        // Cm を名前に含むステージは実行ステージと見なす
        if (stageName == "Cm"){
            op.consCycle = tick;
            op.prodCycle = tick;
        }
        if (stageName == "Mw"){
            op.prodCycle = tick;
        }


        // レーンのマップに登録
        if (!(laneName in this.laneMap_)) {
            this.laneMap_[laneName] = 1;
        }

        // ステージのマップに登録
        this.stageLevelMap_.update(laneName, stageName, laneInfo);
    }

    /**
     * @param {number} seqNum 
     * @param {Op} op 
     * @param {string[]} args 
     */
    parseEndCommand(seqNum, op, args){
        let tick = Number(args[2]);
        if (tick == 0 && this.curParsingInsnFlushed_) {
            // Stages after flush are skipped.
            // If curParsingInsnFlushed_ is not set, this stage has not been closed and should be closed.
            return;
        }

        let laneName = "0"; // Default lane
        let stageName = op.lastParsedStage.name;
        op.lastParsedCycle = tick;

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
    }

    parseRetireCommand(seqNum, op, args){
        //if (seqNum == 11) {
        //    seqNum = seqNum;
        //}

        let tick = Number(args[2]);
        // If tick is 0, this op is flushed.
        if (tick == 0) {
            this.curParsingInsnFlushed_ = true;
            tick = this.curParsingInsnCycle_; // Set the last valid tick
        }
        op.retiredCycle = tick;
        op.lastParsedCycle = tick;

        if (this.curParsingInsnFlushed_) {
            op.flush = true;
            op.retired = false;
        }
        else{
            op.flush = false;
            op.retired = true;
        }

        // Decode label strings
        this.unescapeLabels(op);

        // 閉じていないステージがあった場合はここで閉じる
        for (let laneName in op.lanes) {
            let stages = op.lanes[laneName].stages;
            for (let stage of stages) {
                if (stage.endCycle == 0) {
                    stage.endCycle = tick;
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
        let tick = Number(args[2]);

        switch(cmd) {
        case "fetch": 
            op = this.parseInitialCommand(args);
            break;
        case "decode": 
        case "rename": 
        case "dispatch": 
        case "issue": 
        case "complete": 
            this.parseExLog(op, tick);
            this.parseEndCommand(seqNum, op, args);
            this.parseStartCommand(seqNum, op, args);
            break;
        case "retire": 
            this.parseExLog(op, tick);
            this.parseRetireCommand(seqNum, op, args);
            break;
        }  // switch end

    }

    /** 
     * parseCycleRange までの追加ログをパースして op に追加
     * 追加ログのパース中にステージの追加が行われることがあるため，
     * parseCommand と同期して処理する必要がある．
     * @param {Op} op 
     * @param {number} parseCycleRange
     */
    parseExLog(op, parseCycleRange){
        /** @param {number} seqNum */
        let seqNum = op.gid;
        if (!(seqNum in this.parsingExLog_)) {
            return;
        }

        let opExLog = this.parsingExLog_[seqNum];
        let logList = opExLog.logList;
        while (logList.length) {
            let args = logList[0];
            let tick = args[0];
            if (Number(tick) >= parseCycleRange) {
                break;
            }

            if (args[1] == " user") {
                // 3260000: user: 
                // register values
                op.labelDetail += "\n " + args.join(":");
            }
            else if (args[1] == " global" && args[2] == " RegFile") {
                // register values
                // 3260000: global: RegFile: Setting int register 125 to 0x4af000
                op.labelDetail += "\n " + args[3];
            }
            else if (args[1].match(/\.memDep/) && args[2].match(/ Completed mem/)) {
                // Memory write back
                // 3260000: system.cpu.iq: Completing mem instruction PC: (0x436018=>0x43601c).(0=>1) [sn:157]
                let dummyArgs = ["O3PipeView", "mem_complete", tick];
                this.parseEndCommand(seqNum, op, dummyArgs);
                this.parseStartCommand(seqNum, op, dummyArgs);
            }
            else if (args[1].match(/\.rename/) && 
                args.length > 4 && args[4].match(/ (Renaming)|(Looking)/)
            ) {
                // Rename
                // 3271000: system.cpu.rename: [tid:0]: Renaming arch reg 1 (IntRegClass) to physical reg 152 (152).
                // 2340100: system.cpu.rename: [tid:0]: Looking up IntRegClass arch reg 43, got phys reg 72 (IntRegClass)
                op.labelDetail += "\n " + args[4];
                let dst = args[4].match(/\(([a-zA-Z]+)\) to physical reg (\d+) \(\d+\)/);
                if (dst) {
                    opExLog.dsts.push(dst[1] + dst[2]);
                }
                let src = args[4].match(/got phys reg (\d+) \(([a-zA-Z]+)\)/);
                if (src) {
                    opExLog.srcs.push(src[2] + src[1]);
                }
            }
            else if (
                args[1].match(/\.iew.lsq.thread/) && 
                args[2].match(/ (Read called)|(Doing write)/)
            ) {
                // Load/store addr
                // 3757000: system.cpu.iew.lsq.thread0: Read called, load idx: 14, store idx: -1, storeHead: 24 addr: 0x1efed0
                op.labelDetail += "\n " + args.slice(2, 7).join(":");
            }
            

            // Add log to each stage
            if (op.lastParsedStage.labels != "")
                op.lastParsedStage.labels += "\n";
            op.lastParsedStage.labels += args.join(":");
            logList.shift();
        }
    }
}

module.exports.Gem5O3PipeViewParser = Gem5O3PipeViewParser;
