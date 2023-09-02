let Op = require("./op").Op;
let OpList = require("./op_list").OpList;
let {ParsingOpList} = require("./op_list");
let Dependency = require("./op").Dependency;
let Stage = require("./stage").Stage;
let StageLevelMap = require("./stage").StageLevelMap;
let Lane = require("./stage").Lane;

// To avoid conflicts with node.js internal FileReader, use a different name.
let InternalFileReader = require("./file_reader").FileReader; // eslint-disable-line

class OnikiriParser{

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

        // 現在読み出し中のサイクル
        this.curCycle_ = 0;

        // Op のリスト 
        /** @type {OpList} */
        this.opListBody_ = new OpList();

        /** @type {ParsingOpList} */
        this.parsingOpList_ = new ParsingOpList();

        // パース完了
        this.complete_ = false;

        // 出現したレーンのマップ
        this.laneMap_ = {};

        // ステージの出現順序を記録するマップ
        this.stageLevelMap_ = new StageLevelMap();

        // 読み出し開始時間
        this.startTime_ = 0;

        // 更新間隔のタイマ
        this.updateTimer_ = 100;    // 100行読んだら1回表示するようにしとく

        // 更新ハンドラの呼び出し回数
        this.updateCount_ = 0;    

        // 強制終了
        this.closed_ = false;

        // Error
        this.error_ = false;

        // 警告数
        this.numWarning_ = 0;
    }

    
    // Public methods

    // 閉じる
    close(){
        this.closed_ = true;
        this.opListBody_.close();
        this.parsingOpList_.close();
        this.numWarning_ = 0;
    }

    // Error handling
    /** @param {string} msg */
    setError_(msg) {
        this.error_ = true;
        console.log(`Error (line:${this.curLine_}): ${msg}`);
    }

    warning_(msg) {
        this.numWarning_++;
        if (this.numWarning_ < 10) {
            console.log(`Warning (line:${this.curLine_}): ${msg}`);
        }
        else if (this.numWarning_ == 10) {
            console.log(`Too many warnings. Now warning messages are omitted to output.`);
        }
    }

    /**
     * @return {string} パーサーの名前を返す
     */
    get name(){
        return "OnikiriParser";
    }

    // updateCallback(percent, count): 読み出し状況を 0 から 1.0 で渡す．count は呼び出し回数
    /**
     * @param {InternalFileReader} file 
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
        try {
            this.parseLineBody_(line);
        }
        catch (e) {
            this.errorCallback_(false, e);
        }
    }
    /**
     * @param {string} line 
     */
    parseLineBody_(line){
        if (this.closed_) {
            // Node.js はファイル読み出しが中断されクローズされた後も，
            // バッファにたまっている分はコールバック読み出しを行うため，
            // きちんと無視する必要がある
            return;
        }
        if (this.error_) {
            return;
        }
        if (this.curLine_ == 1) {
            if (!line.match(/^Kanata/)) {   // This file is not Kanata log.
                this.errorCallback_(true);
                return;
            }
        }

        let args = line.split(/\t/);
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
        for (let parsingID_Str of this.parsingOpList_.parsingID_List) {
            // 既にその ID がパース完了されていたら終了
            let parsingID = Number(parsingID_Str);
            let op = this.opListBody_.getParsedOp(parsingID);
            if (op) {
                break;
            }
            
            let parsingOp = this.parsingOpList_.getParsingOp(parsingID);
            if (!parsingOp) {
                this.warning_(`Incorrect parsing op appears ${parsingID}`)
                break;  // パース中命令がなければ終了だが，ここにくることはないはず
            }

            parsingOp.retiredCycle = this.curCycle_ + 1;   // 最後のステージを表示するために +1
            parsingOp.eof = true;
            this.unescapeLabels(parsingOp);
            this.parsingOpList_.purge(parsingID);
            this.opListBody_.setOp(parsingID, parsingOp);
        }

        this.opListBody_.setParsedLastID(this.parsingOpList_.parsingLastID);

        this.complete_ = true;

        let elapsed = ((new Date()).getTime() - this.startTime_);

        this.updateCallback_(1.0, this.updateCount_);
        this.finishCallback_();
        console.log(`Parsed (${this.name}): ${elapsed} ms`);
    }

    /**
     * @param {Op} op 
     */
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
        if (op != null) {
            this.setError_(`${id} is re-defined in the "I" command.`);
            return;
        }
        if (args.length < 4) {
            this.setError_(`The number of the arguments for the "I" command must be 4, but it is ${args.length}.`);
        }
        op = new Op();
        op.id = id;
        op.gid = this.parseInt_(args[2]);
        op.tid = this.parseInt_(args[3]);
        op.fetchedCycle = this.curCycle_;
        op.line = this.curLine_;
        this.parsingOpList_.setOp(id, op);
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
        if (op == null) {
            this.setError_(`Undefined id:${id} is referred in the "L" command.`);
            return;
        }
        if (args.length < 4) {
            this.setError_(`The number of the arguments for the "L" command must be 4, but it is ${args.length}.`);
        }
        let type = this.parseInt_(args[2]);
        let str = args[3];

        if (type == 0) {
            op.labelName += str;
        }
        else if (type == 1) {
            op.labelDetail += str;
        }
        else if (type == 2) {
            if (op.lastParsedStage.labels != "")
                op.lastParsedStage.labels += "\n";
            op.lastParsedStage.labels += str;
        }
    }

    /** 
     * @param {number} id 
     * @param {Op} op
     * @param {string[]} args
     * */
    parseStartCommand(id, op, args){
        if (op == null) {
            this.setError_(`Undefined id:${id} is referred in the "S" command.`);
            return;
        }
        if (args.length < 4) {
            // Some log generators generate log data including tabs or spaces after the commands.
            // In this case, args.length is larger than 4 and (args.length < 4) accepts this case.
            this.setError_(`The number of the arguments for the "S" command must be 4, but it is ${args.length}.`);
        }

        let laneName = this.parseStageAndLaneName_(args[2]);
        let stageName = this.parseStageAndLaneName_(args[3]);
        let stage = new Stage();
        stage.name = stageName;
        stage.startCycle = this.curCycle_;
        if (!(laneName in op.lanes)) {
            op.lanes[laneName] = new Lane;
        }

        let laneInfo = op.lanes[laneName];

        // そのレーンの最後のステージが閉じられていない場合，自動で閉じる
        if (laneInfo.stages.length > 0) {
            let lastStage = laneInfo.stages[laneInfo.stages.length - 1];
            if (lastStage.endCycle == 0) {  
                this.parseEndCommand(id, op, ["E", args[1], laneName, lastStage.name]);
            }
        }

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
        this.stageLevelMap_.update(laneName, stageName, laneInfo);
    }

    /**
     * @param {number} id 
     * @param {Op} op 
     * @param {string[]} args 
     */
    parseEndCommand(id, op, args){
        if (op == null) {
            this.setError_(`Undefined id:${id} is referred in the "E" command.`);
            return;
        }
        if (args.length < 4) {
            this.setError_(`The number of the arguments for the "E" command must be 4, but it is ${args.length}.`);
        }

        let laneName = this.parseStageAndLaneName_(args[2]);
        let stageName = this.parseStageAndLaneName_(args[3]);
        let stage = null;
        let laneInfo = op.lanes[laneName];
        if (!laneInfo) {
            this.setError_(`Lane name "${laneName}" is not defined at id:${id}.`);
            return;
        }
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

    /** 
     *  @param {number} id 
     *  @param {Op} op
     *  @param {string[]} args 
    */
    parseRetireCommand(id, op, args){
        if (op == null) {
            this.setError_(`Undefined id:${id} is referred in the "R" command.`);
            return;
        }
        if (args.length < 4) {
            this.setError_(`The number of the arguments for the "R" command must be 4, but it is ${args.length}.`);
        }

        op.rid = this.parseInt_(args[2]);
        op.retiredCycle = this.curCycle_;
        if (this.parseInt_(args[3]) == 1) {
            op.flush = true;
            op.retired = false;
        }
        else{
            op.flush = false;
            op.retired = true;
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
        this.unescapeLabels(op);


        // パース完了により，parsingOpList_ から opListBody_ に移す
        this.parsingOpList_.purge(id);
        this.opListBody_.setOp(id, op);

        if (this.opListBody_.parsedLastID < id) {
            this.opListBody_.setParsedLastID(id);
        }

        if (!op.flush) {
            this.opListBody_.setParsedRetiredOp(op.rid, op);
        }

    }

    /** 
     * @param {number} id 
     * @param {Op} op
     * @param {Array<string>} args
    */
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

        if (args.length < 4) {
            this.setError_(`The number of the arguments for the "W" command must be 4, but it is ${args.length}.`);
        }
        let prodId = this.parseInt_(args[2]);
        let prod = this.parsingOpList_.getParsingOp(prodId);
        if (!prod) {
            prod = this.opListBody_.getParsedOp(prodId);
        }
        if (!prod) {
            this.setError_(`An invalid producer id (${prodId}) is specified for the "W" command.`);
            return;
        }
        let type = this.parseInt_(args[3]);
        op.prods.push(new Dependency(prod.id, type, this.curCycle_));
        prod.cons.push(new Dependency(op.id, type, this.curCycle_));
    }

    /** @param {string[]} args */
    parseCommand(args){

        let cmd = args[0];
        switch (cmd) {
        case "C":
            // 前回ログ出力時からの経過サイクル数を指定
            // フォーマット
            //      C	<CYCLE>
            // <CYCLE>: 経過サイクル数
            if (args.length < 2 || args[1] == "") {
                this.setError_("'C' command has invalid arguments.");
                return;
            }
            this.curCycle_ += this.parseInt_(args[1]);
            return;
        case "Kanata":
            return;
        case "C=":
            return;
        }


        let id = this.parseInt_(args[1]);
        let op = this.parsingOpList_.getParsingOp(id);
        let parsedOpUsed = false;
        if (cmd != "I" && !op) {
            op = this.opListBody_.getParsedOp(id);
            if (op) {
                parsedOpUsed = true;
                this.warning_(`Command appears after op:(${id}) is retired or flushed`);
            }
        }

        switch(cmd) {
        
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

        default:
            this.warning_(`Unknown command:${cmd}`);
            break;
        }

        // opListBody から得た場合は再反映させる
        if (parsedOpUsed) {
            this.opListBody_.setOp(id, op);
        }
    }

    /** @param {string} str*/
    parseInt_(str) {
        if (str == undefined) {
            return 0;
        }
        return Number(str.trim());
    }

    /** @param {string} str*/
    parseStageAndLaneName_(str) {
        if (str == undefined) {
            return "";
        }
        return str.trim();
    }
}

module.exports.OnikiriParser = OnikiriParser;
