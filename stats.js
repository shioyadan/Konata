// JSDoc のタイプチェックに型を認識させるため
let Op = require("./op").Op; // eslint-disable-line

class GenericStats{
    constructor(lastID, lastRID, lastCycle){

        this.stats_ = {
            numFetchedOps: lastID,
            numCommittedOps: lastRID,
            numCycles: lastCycle,

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
            
            ipc: lastRID / lastCycle
        };

        this.prevBr_ = false;
        this.prevJump_ = false;
        this.prevStore_ = false;
        this.prevFlushed_ = false;

        this.inBrFlush_ = false;
        this.inJumpFlush_ = false;
        this.inMemFlush_ = false;

        this.isDetected_ = true;    // 常に true
    }

    get name(){
        return "GenericStats";
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
        
        if (this.isBranch_(op.labelName)) {
            s.numFetchedBr++;
            if (op.retired) {
                s.numRetiredBr++;
            }
            this.prevBr_ = true;
        }
        else {
            this.prevBr_ = false;
        }

        if (this.isJump_(op.labelName)) {
            s.numFetchedJump++;
            if (op.retired) {
                s.numRetiredJump++;
            }
            this.prevJump_ = true;
        }
        else {
            this.prevJump_ = false;
        }

        if (this.isStore_(op.labelName)) {
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

    // ラベル内に b で始まる単語が入っていれば分岐
    isBranch_(text){
        return text.match(/[\s][b][^\s]*[\s]*/);
    }

    // j, call, ret はジャンプ
    isJump_(text){
        return text.match(/[\s]([j])|(call)|(ret)[^\s]*[\s]*/);
    }
    
    // st,sw,sh,sb から始まっていたらストア
    isStore_(text){
        return text.match(/[\s](st)|(sw)|(sh)|(sb)[^\s]*[\s]*/);
    }

    get isDetected() {return this.isDetected_;}
}

class X86_Gem5_Stats extends GenericStats{
    constructor(lastID, lastRID, lastCycle){
        super(lastID, lastRID, lastCycle);
        this.isDetected_ = false;
    }

    get name(){
        return "X86_Gem5_Stats";
    }

    update(op){
        super.update(op);

        if (!this.isDetected_ ) {
            let text = op.labelName;
            if (text.match(/[eErR][aAbBcCdD][xX][^,]*,[^,]*[eErR][aAbBcCdD][xX]/)) {
                this.isDetected_  = true;
            }
            if (text.match(/[xXyY][mM][mM][^,]*,[^,]*[xXyY][mM][mM]/)) {
                this.isDetected_  = true;
            }
            if (this.isDetected_) {
                console.log(`Detected X86-Gem5 from '${text}' in X86_Gem5_Stats`);
            }
        }
    }


    // J で始まり JMP ではなく，wrip に分解される命令は条件分岐
    isBranch_(text){
        return text.match(/[\s]*[jJ][^mM][^:]+:\s*wrip/);
    }

    // jmX, call, ret で wrip はジャンプ
    isJump_(text){
        return text.match(/([\s]*([jJ][mM])|([cC][aA][lL][lL])|([rR][eE][tT]))[^:]+:\s*wrip/);
    }
    
    // : st はストア
    isStore_(text){
        return text.match(/[\s]*[^:]+:\s*st/);
    }
}

/** 
 * @returns {GenericStats[]} */
function CreateStats(lastID, lastRID, lastCycle){
    return [
        new X86_Gem5_Stats(lastID, lastRID, lastCycle),
        new GenericStats(lastID, lastRID, lastCycle),
    ];
}

//module.exports.GenericStats = GenericStats;
module.exports.CreateStats = CreateStats;
