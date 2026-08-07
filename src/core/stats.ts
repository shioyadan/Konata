import type { Op } from "./model";

export interface StatsValues {
    numFetchedOps: number;
    numCommittedOps: number;
    numCycles: number;
    numFlush: number;
    numFlushedOps: number;
    numBrFlushedOps: number;
    numJumpFlushedOps: number;
    numSpeculativeMemFlushedOps: number;
    numFetchedBr: number;
    numRetiredBr: number;
    numBrPredMiss: number;
    rateBrPredMiss: number;
    mpkiBrPred: number;
    numFetchedJump: number;
    numRetiredJump: number;
    numJumpPredMiss: number;
    rateJumpPredMiss: number;
    mpkiJumpPred: number;
    numFetchedStore: number;
    numRetiredStore: number;
    numSpeculativeMemMiss: number;
    rateSpeculativeMemMiss: number;
    mpkiSpeculativeMemMiss: number;
    ipc: number;
}

export class GenericStats {
    protected readonly stats_: StatsValues;
    protected isDetected_ = true;
    private prevBr_ = false;
    private prevJump_ = false;
    private prevStore_ = false;
    private prevFlushed_ = false;
    private inBrFlush_ = false;
    private inJumpFlush_ = false;
    private inMemFlush_ = false;

    constructor(lastID: number, lastRID: number, lastCycle: number) {
        // ここでは件数へ直さず、現行版と同じ最終ID/RIDを統計値として保持する。
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
            ipc: lastRID / lastCycle,
        };
    }

    get name(): string {
        return "GenericStats";
    }

    get stats(): Readonly<StatsValues> {
        return this.stats_;
    }

    get isDetected(): boolean {
        return this.isDetected_;
    }

    finish(): void {
        // 現行版と同じく全命令を数えた後で率とMPKIを確定する。
        const stats = this.stats_;
        stats.rateBrPredMiss = stats.numBrPredMiss / stats.numRetiredBr;
        stats.mpkiBrPred = stats.numBrPredMiss / stats.numCommittedOps * 1000;
        stats.rateJumpPredMiss = stats.numJumpPredMiss / stats.numRetiredJump;
        stats.mpkiJumpPred = stats.numJumpPredMiss / stats.numCommittedOps * 1000;
        stats.rateSpeculativeMemMiss = stats.numSpeculativeMemMiss / stats.numRetiredStore;
        stats.mpkiSpeculativeMemMiss = stats.numSpeculativeMemMiss / stats.numCommittedOps * 1000;
    }

    update(op: Readonly<Op>): void {
        const stats = this.stats_;
        if (op.flush) {
            if (!this.prevFlushed_) {
                // 一つ前の命令がflushでなければ、ここを連続したflush列の起点とする。
                stats.numFlush++;
                if (this.prevBr_) {
                    this.inBrFlush_ = true;
                    stats.numBrPredMiss++;
                }
                if (this.prevJump_) {
                    this.inJumpFlush_ = true;
                    stats.numJumpPredMiss++;
                }
                if (this.prevStore_) {
                    this.inMemFlush_ = true;
                    stats.numSpeculativeMemMiss++;
                }
            }

            stats.numFlushedOps++;
            if (this.inBrFlush_) {
                stats.numBrFlushedOps++;
            }
            else if (this.inJumpFlush_) {
                stats.numJumpFlushedOps++;
            }
            else if (this.inMemFlush_) {
                stats.numSpeculativeMemFlushedOps++;
            }
        }
        else {
            this.inBrFlush_ = false;
            this.inJumpFlush_ = false;
            this.inMemFlush_ = false;
        }
        this.prevFlushed_ = op.flush;

        this.prevBr_ = this.isBranch_(op.labelName);
        if (this.prevBr_) {
            stats.numFetchedBr++;
            if (op.retired) {
                stats.numRetiredBr++;
            }
        }

        this.prevJump_ = this.isJump_(op.labelName);
        if (this.prevJump_) {
            stats.numFetchedJump++;
            if (op.retired) {
                stats.numRetiredJump++;
            }
        }

        this.prevStore_ = this.isStore_(op.labelName);
        if (this.prevStore_) {
            stats.numFetchedStore++;
            if (op.retired) {
                stats.numRetiredStore++;
            }
        }
    }

    // ラベル内にbで始まる単語が入っていれば分岐とみなす。
    protected isBranch_(text: string): boolean {
        return /[\s][b][^\s]*[\s]*/.test(text);
    }

    // j、call、retはジャンプとみなす。
    protected isJump_(text: string): boolean {
        return /[\s]([j])|(call)|(ret)[^\s]*[\s]*/.test(text);
    }

    // st、sw、sh、sbから始まる単語をstoreとみなす。
    protected isStore_(text: string): boolean {
        return /[\s](st)|(sw)|(sh)|(sb)[^\s]*[\s]*/.test(text);
    }
}

export class X86Gem5Stats extends GenericStats {
    constructor(lastID: number, lastRID: number, lastCycle: number) {
        super(lastID, lastRID, lastCycle);
        this.isDetected_ = false;
    }

    get name(): string {
        return "X86_Gem5_Stats";
    }

    update(op: Readonly<Op>): void {
        super.update(op);

        if (!this.isDetected_) {
            const text = op.labelName;
            if (/[eErR][aAbBcCdD][xX][^,]*,[^,]*[eErR][aAbBcCdD][xX]/.test(text)) {
                this.isDetected_ = true;
            }
            if (/[xXyY][mM][mM][^,]*,[^,]*[xXyY][mM][mM]/.test(text)) {
                this.isDetected_ = true;
            }
            if (this.isDetected_) {
                console.log(`Detected X86-Gem5 from '${text}' in X86_Gem5_Stats`);
            }
        }
    }

    // Jで始まりJMPではなく、wripに分解される命令は条件分岐とみなす。
    protected isBranch_(text: string): boolean {
        return /[\s]*[jJ][^mM][^:]+:\s*wrip/.test(text);
    }

    // jmX、call、retでwripを含むものはジャンプとみなす。
    protected isJump_(text: string): boolean {
        return /([\s]*([jJ][mM])|([cC][aA][lL][lL])|([rR][eE][tT]))[^:]+:\s*wrip/.test(text);
    }

    // コロン以降がstで始まる命令をstoreとみなす。
    protected isStore_(text: string): boolean {
        return /[\s]*[^:]+:\s*st/.test(text);
    }
}

export function createStats(lastID: number, lastRID: number, lastCycle: number): GenericStats[] {
    return [
        new X86Gem5Stats(lastID, lastRID, lastCycle),
        new GenericStats(lastID, lastRID, lastCycle),
    ];
}
