class Konata{
    constructor(){
        this.name = "Konata";
        this.parser_ = null;
        this.FileReader_ = require("./file_reader").FileReader;
        this.OnikiriParser_ = require("./onikiri_parser").OnikiriParser;

        this.file_ = null;
        this.filePath_ = ""; 
        this.updateCallback_ = null;
        this.finishCallback_ = null;
    }

    close(){
        if (this.parser_) {
            this.parser_.close();
            this.parser_ = null;
        }
        if (this.file_){
            this.file_.close();
            this.file_ = null;
        }
        console.log(`closed ${this.filePath_}`);
    }

    openFile(path, updateCallback, finishCallback){
        this.filePath_ = path;
        this.updateCallback_ = updateCallback;
        this.finishCallback_ = finishCallback;

        this.reload();
    }

    reload(){
        this.close();
        this.file_ = new this.FileReader_();
        this.file_.open(this.filePath_);

        let parser = new this.OnikiriParser_();
        this.parser_ = parser;
        console.log("Open :", this.filePath_);

        let self = this;
        parser.setFile(
            this.file_, 
            this.updateCallback_, 
            function(){ // Finish handler
                self.file_.close();
                self.finishCallback_();
            }
        );
        console.log("Selected parser:" , parser.getName());
    }

    /**
     * @return {Op} id に対応した op を返す
     */
    getOp(id){
        return this.parser_.getOp(id);
    }

    getOpFromRID(rid){
        return this.parser_.getOpFromRID(rid);
    }

    get lastID(){
        return this.parser_.lastID;
    }

    get lastRID(){
        return this.parser_.lastRID;
    }

    get laneMap(){
        return this.parser_.laneMap;
    }

    get stageLevelMap(){
        return this.parser_.stageLevelMap;
    }

    // パイプライン中の統計を計算し，終わったら callback に渡す
    stats(callback){
        let lastID = this.lastID;
        let s = {
            numFetchedOps: lastID,
            numCommittedOps: this.lastRID,
            numCycles: this.parser_.lastCycle,

            numFlush: 0,
            numFlushedOps: 0,

            numBr: 0,
            numBrPredMiss: 0,
            missRateBrPred: 0,
            mpkiBrPred: 0,

            numJump: 0,
            numJumpPredMiss: 0,
            missRateJumpPred: 0,
            mpkiJumpPred: 0,
            
            ipc: this.lastRID / this.parser_.lastCycle
        };

        let prevBr = false;
        let prevJump = false;
        let prevFlushed = false;
        for (let i = 0; i < lastID; i++) {
            let op = this.getOp(i);

            if (op.flush) {
                s.numFlushedOps++;
                if (!prevFlushed) { 
                    // 一つ前の命令がフラッシュされていなければ，ここがフラッシュの起点
                    s.numFlush++;
                    if (prevBr) {
                        s.numBrPredMiss++;
                    }
                    if (prevJump) {
                        s.numJumpPredMiss++;
                    }
                }
            }
            prevFlushed = op.flush;
            
            // ラベル内に b で始まる単語が入っていれば分岐
            if (op.labelName.match(/[\s][b][^\s]*[\s]/)) {
                s.numBr++;
                prevBr = true;
            }
            else {
                prevBr = false;
            }

            if (op.labelName.match(/[\s]([j])|(call)|(ret)[^\s]*[\s]/)) {
                s.numJump++;
                prevJump = true;
            }
            else {
                prevJump = false;
            }
        }

        // post process
        s.missRateBrPred = s.numBrPredMiss / s.numBr;
        s.mpkiBrPred = s.numBrPredMiss / s.numCommittedOps * 1000;
        s.missRateJumpPred = s.numJumpPredMiss / s.numJump;
        s.mpkiJumpPred = s.numJumpPredMiss / s.numCommittedOps * 1000;
        
        callback(s);
    }

}

module.exports.Konata = Konata;
