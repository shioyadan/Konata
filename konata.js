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

            numBrFlush: 0,
            numBrFlushedOps: 0,

            numStoreFlush: 0,
            numStoreFlushedOps: 0,

            numFetchedBr: 0,
            numRetiredBr: 0,
            numBrPredMiss: 0,
            rateBrPredMiss: 0,
            mpkiBrPred: 0,

            numFetchedJump: 0,
            numRetiredJump: 0,
            numJumpPredMiss: 0,
            rateJumpPredMiss: 0,
            mpkiJumpPred: 0,
            
            numFetchedStore: 0,
            numRetiredStore: 0,
            numSpeculativeStoreMiss: 0,
            rateSpeculativeStore: 0,
            mpkiSpeculativeStore: 0,
            
            ipc: this.lastRID / this.parser_.lastCycle
        };

        let prevBr = false;
        let prevJump = false;
        let prevStore = false;
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
                    if (prevStore) {
                        s.numSpeculativeStoreMiss++;
                    }
                }
            }
            prevFlushed = op.flush;
            
            // ラベル内に b で始まる単語が入っていれば分岐
            if (op.labelName.match(/[\s][b][^\s]*[\s]*/)) {
                s.numFetchedBr++;
                if (op.retired) {
                    s.numRetiredBr++;
                }
                prevBr = true;
            }
            else {
                prevBr = false;
            }

            // j, call, ret はジャンプ
            if (op.labelName.match(/[\s]([j])|(call)|(ret)[^\s]*[\s]*/)) {
                s.numFetchedJump++;
                if (op.retired) {
                    s.numRetiredJump++;
                }
                prevJump = true;
            }
            else {
                prevJump = false;
            }

            // st,sw,sh,sb から始まっていたらストア
            if (op.labelName.match(/[\s](st)|(sw)|(sh)|(sb)[^\s]*[\s]*/)) {
                s.numFetchedStore++;
                if (op.retired) {
                    s.numRetiredStore++;
                }
                prevStore = true;
            }
            else {
                prevStore = false;
            }
        }

        // post process
        s.rateBrPredMiss = s.numBrPredMiss / s.numRetiredBr;
        s.mpkiBrPred = s.numBrPredMiss / s.numCommittedOps * 1000;
        s.rateJumpPredMiss = s.numJumpPredMiss / s.numRetiredJump;
        s.mpkiJumpPred = s.numJumpPredMiss / s.numCommittedOps * 1000;

        s.rateSpeculativeStore = s.numSpeculativeStoreMiss / s.numRetiredStore;
        s.mpkiSpeculativeStore = s.numSpeculativeStoreMiss / s.numCommittedOps * 1000;

        callback(s);
    }

}

module.exports.Konata = Konata;
