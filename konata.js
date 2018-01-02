class Konata{
    constructor(){
        this.name = "Konata";
        this.parser_ = null;
        this.FileReader_ = require("./file_reader").FileReader;
        this.OnikiriParser_ = require("./onikiri_parser").OnikiriParser;
        this.Gem5O3PipeViewParser_ = require("./gem5_o3_pipe_view_parser").Gem5O3PipeViewParser;

        this.file_ = null;
        this.filePath_ = ""; 
        // Callback handlers
        this.updateCallback_ = null;
        this.finishCallback_ = null;
        this.errorCallback_ = null;
    }

    close(){
        if (this.parser_) {
            this.parser_.close();
            this.parser_ = null;
        }
        if (this.file_){
            this.file_.close();
            this.file_ = null;
            console.log(`Closed: ${this.filePath_}`);
        }
    }

    openFile(path, updateCallback, finishCallback, errorCallback){
        this.filePath_ = path;
        this.updateCallback_ = updateCallback;
        this.finishCallback_ = finishCallback;
        this.errorCallback_ = errorCallback;

        this.reload();
    }

    reload(){
        let parsers = [
            new this.OnikiriParser_(),
            new this.Gem5O3PipeViewParser_()
        ];
        this.load_(parsers);
    }

    /**
     * 与えられた paser を使ってファイルのロードを試みる
     * @param {array} parsers - パーサーのリスト．先頭から順に読み出し試行される
     */
    load_(parsers){
        this.close();
        this.file_ = new this.FileReader_();
        this.file_.open(this.filePath_);

        this.parser_ = parsers.shift();
        console.log(`Open (${this.parser_.name}): ${this.filePath_}`);

        let self = this;
        this.parser_.setFile(
            this.file_, 
            this.updateCallback_, 
            function(){ // Finish handler
                self.file_.close(); // The parser must not be closed.
                self.finishCallback_();
            },
            function(){ // Error handler
                console.log("Filed to load by:", self.parser_.name);
                self.close();
                // 読み出し試行に失敗したの次のパーサーに
                if (parsers.length > 0) {
                    self.load_(parsers);
                }
                else if (parsers.length == 0) {
                    self.errorCallback_("Unsupported file format.");
                }
            }
        );
    }

    /**
     * @return {Op} id に対応した op を返す
     */
    getOp(id){
        return this.parser_ ? this.parser_.getOp(id) : null;
    }

    getOpFromRID(rid){
        return this.parser_ ? this.parser_.getOpFromRID(rid) : null;
    }

    get lastID(){
        return this.parser_ ? this.parser_.lastID : 0;
    }

    get lastRID(){
        return this.parser_ ? this.parser_.lastRID : 0;
    }

    get laneMap(){
        return this.parser_ ? this.parser_.laneMap : {};
    }

    get stageLevelMap(){
        return this.parser_ ? this.parser_.stageLevelMap : {};
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

            numBrFlushedOps: 0,
            numJumpFlushedOps: 0,
            numSpeculativeMemFlushedOps: 0,

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
            numSpeculativeMemMiss: 0,
            rateSpeculativeMemMiss: 0,
            mpkiSpeculativeMemMiss: 0,
            
            ipc: this.lastRID / this.parser_.lastCycle
        };

        let prevBr = false;
        let prevJump = false;
        let prevStore = false;
        let prevFlushed = false;

        let inBrFlush = false;
        let inJumpFlush = false;
        let inMemFlush = false;

        for (let i = 0; i < lastID; i++) {
            let op = this.getOp(i);
            if (op == null) {
                continue;
            }

            if (op.flush) {
                
                if (!prevFlushed) { 
                    // 一つ前の命令がフラッシュされていなければ，ここがフラッシュの起点
                    s.numFlush++;
                    if (prevBr) {
                        inBrFlush = true;
                        s.numBrPredMiss++;
                    }
                    if (prevJump) {
                        inJumpFlush = true;
                        s.numJumpPredMiss++;
                    }
                    if (prevStore) {
                        inMemFlush = true;
                        s.numSpeculativeMemMiss++;
                    }
                }
                // Count the number of flushed ops
                s.numFlushedOps++;
                if (inBrFlush) {
                    s.numBrFlushedOps++;
                }
                else if (inJumpFlush) {
                    s.numJumpFlushedOps++;
                }
                else if (inMemFlush) {
                    s.numSpeculativeMemFlushedOps++;
                }
            }
            else {
                inBrFlush = false;
                inJumpFlush = false;
                inMemFlush = false;
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

        s.rateSpeculativeMemMiss = s.numSpeculativeMemMiss / s.numRetiredStore;
        s.mpkiSpeculativeMemMiss = s.numSpeculativeMemMiss / s.numCommittedOps * 1000;

        callback(s);
    }

}

module.exports.Konata = Konata;
