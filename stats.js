// JSDoc のタイプチェックに型を認識させるため
let Op = require("./op").Op; // eslint-disable-line
let Konata = require("./konata").Konata; // eslint-disable-line

class Stats{
    /** @param {Konata} konata */
    constructor(konata){
        let lastID = konata.lastID;

        this.stats_ = {
            numFetchedOps: lastID,
            numCommittedOps: konata.lastRID,
            numCycles: konata.parser_.lastCycle,

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
            
            ipc: konata.lastRID / konata.parser_.lastCycle
        };

        this.prevBr_ = false;
        this.prevJump_ = false;
        this.prevStore_ = false;
        this.prevFlushed_ = false;

        this.inBrFlush_ = false;
        this.inJumpFlush_ = false;
        this.inMemFlush_ = false;
    }

    get stats() {return this.stats_;}

    finish(){
        // post process
        let s = this.stats_;
        s.rateBrPredMiss = s.numBrPredMiss / s.numRetiredBr;
        s.mpkiBrPred = s.numBrPredMiss / s.numCommittedOps * 1000;

        s.rateJumpPredMiss = s.numJumpPredMiss / s.numRetiredJump;
        s.mpkiJumpPred = s.numJumpPredMiss / s.numCommittedOps * 1000;

        s.rateSpeculativeMemMiss = s.numSpeculativeMemMiss / s.numRetiredStore;
        s.mpkiSpeculativeMemMiss = s.numSpeculativeMemMiss / s.numCommittedOps * 1000;
    }

    /** @param {Op} op */
    update(op) {
        let s = this.stats_;
        if (op.flush) {
                
            if (!this.prevFlushed_) { 
                // 一つ前の命令がフラッシュされていなければ，ここがフラッシュの起点
                s.numFlush++;
                if (this.prevBr_) {
                    this.inBrFlush_ = true;
                    s.numBrPredMiss++;
                }
                if (this.prevJump_) {
                    this.inJumpFlush_ = true;
                    s.numJumpPredMiss++;
                }
                if (this.prevStore_) {
                    this.inMemFlush_ = true;
                    s.numSpeculativeMemMiss++;
                }
            }
            // Count the number of flushed ops
            s.numFlushedOps++;
            if (this.inBrFlush_) {
                s.numBrFlushedOps++;
            }
            else if (this.inJumpFlush_) {
                s.numJumpFlushedOps++;
            }
            else if (this.inMemFlush_) {
                s.numSpeculativeMemFlushedOps++;
            }
        }
        else {
            this.inBrFlush_ = false;
            this.inJumpFlush_ = false;
            this.inMemFlush_ = false;
        }
        this.prevFlushed_ = op.flush;
        
        // ラベル内に b で始まる単語が入っていれば分岐
        if (op.labelName.match(/[\s][b][^\s]*[\s]*/)) {
            s.numFetchedBr++;
            if (op.retired) {
                s.numRetiredBr++;
            }
            this.prevBr_ = true;
        }
        else {
            this.prevBr_ = false;
        }

        // j, call, ret はジャンプ
        if (op.labelName.match(/[\s]([j])|(call)|(ret)[^\s]*[\s]*/)) {
            s.numFetchedJump++;
            if (op.retired) {
                s.numRetiredJump++;
            }
            this.prevJump_ = true;
        }
        else {
            this.prevJump_ = false;
        }

        // st,sw,sh,sb から始まっていたらストア
        if (op.labelName.match(/[\s](st)|(sw)|(sh)|(sb)[^\s]*[\s]*/)) {
            s.numFetchedStore++;
            if (op.retired) {
                s.numRetiredStore++;
            }
            this.prevStore_ = true;
        }
        else {
            this.prevStore_ = false;
        }

    }
}

module.exports.Stats = Stats;
