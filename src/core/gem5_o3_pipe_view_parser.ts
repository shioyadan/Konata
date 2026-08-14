import {
    FileLineReader,
    type ProgressCallback,
} from "./file_line_reader";
import {
    Dependency,
    Op,
    ParsedTrace,
    Stage,
    StageLevelMap,
    getOrCreateLane,
    getLastParsedStage,
    type TraceUpdateCallback,
} from "./model";
import { ArrayOpStore, type MutableOpStore } from "./op_store";

class Gem5O3PipeViewExLogInfo {
    readonly logList: string[][] = [];
    readonly srcs: string[] = [];
    readonly dsts: string[] = [];
    threadID: number | null = null;
}

const GIVING_UP_LINE = 20000;
const BUFFERED_SIZE = 1024 * 16;
const STAGE_LABELS: Readonly<Record<string, string>> = {
    fetch: "F",
    decode: "Dc",
    rename: "Rn",
    dispatch: "Ds",
    issue: "Is",
    complete: "Cm",
    retire: "Rt",
    // retire前に観測したmemory completeを従来どおりpipeline stageとして扱う。
    mem_complete: "Mc",
};
const SERIAL_NUMBER_PATTERN = /sn:(\d+)/;
const THREAD_ID_PATTERN = /\[tid:\s*(\d+)\]/;

export class Gem5O3PipeViewParser {
    readonly name = "Gem5O3PipeViewParser";

    // 現在の行番号と、cycleへ変換した最後のretire位置。
    private currentLine_ = 1;
    private currentCycle_ = 0;

    // seqNum、flush状態、tickからなる現在のO3PipeView命令context。
    private currentSeqNum_ = 0;
    private currentInstructionFlushed_ = false;
    private currentInstructionTick_ = -1;

    // O3PipeViewは命令順に出力されないため、seqNum順へ並べ直すまでここへ保持する。
    private readonly parsingOps_ = new Map<number, Op>();
    private readonly reorderedOps_ = new Map<number, Op>();
    private reorderedLastID_ = -1;
    private lastGID_ = -1;
    private lastNotFlushedID_ = -1;

    // O3PipeView以外の追加ログと、register依存を解決するためのtable。
    private readonly parsingExLogs_ = new Map<number, Gem5O3PipeViewExLogInfo>();
    private parsingExLogLastGID_ = -1;
    private readonly dependencyTable_ = new Map<string, Op>();

    private readonly stageLevelMap_ = new StageLevelMap();
    private ticksPerClock_ = -1;
    private cycleBegin_ = -1;
    private gidBegin_ = -1;
    private isGem5O3PipeView_ = false;
    // 現行版と同じく、最初は100行、その後は16K行ごとに完了命令をdrainする。
    private updateTimer_ = 100;

    constructor(private readonly opStore_: MutableOpStore = new ArrayOpStore()) {}

    async parse(
        reader: FileLineReader,
        onProgress?: ProgressCallback,
        onUpdate?: TraceUpdateCallback,
        signal?: AbortSignal,
    ): Promise<ParsedTrace> {
        const trace = new ParsedTrace(
            reader.name,
            this.opStore_,
            this.stageLevelMap_,
            this.currentCycle_,
        );
        let formatPublished = false;
        const updateTrace = () => {
            trace.updateLastCycle(this.currentCycle_);
            onUpdate?.(trace);
        };

        await reader.readLines(
            (line) => {
                // 行ごとのPromiseを作らないことが大規模traceのGC負荷に直結するため、
                // FileLineReaderから受けた行はasync処理を挟まず、その場で解析する。
                this.parseLine_(line);
                if (!formatPublished && this.isGem5O3PipeView_) {
                    // 最初のO3PipeView recordまでは追加ログの可能性があり、形式確定後だけ公開する。
                    formatPublished = true;
                    updateTrace();
                }
            },
            (progress) => {
                onProgress?.(progress);
                if (formatPublished) {
                    updateTrace();
                }
            },
            signal,
        );
        if (reader.canceled) {
            // cancel時には最終drainを行わず、途中までの命令をそのまま解放する。
            trace.close();
            throw new Error("File loading was canceled.");
        }
        if (!this.isGem5O3PipeView_) {
            throw new Error("The selected file is not a gem5 O3PipeView trace.");
        }

        // 未処理の命令も、ファイル終端ではbuffer数にかかわらず確定する。
        this.drainParsingOps_(true);
        this.parsingOps_.clear();
        this.reorderedOps_.clear();
        this.parsingExLogs_.clear();
        this.dependencyTable_.clear();

        updateTrace();
        return trace;
    }

    private parseLine_(line: string): void {
        const args = line.split(":");
        if (args[0] === "O3PipeView") {
            this.isGem5O3PipeView_ = true;
            this.parseCommand_(args);
        }
        else {
            if (!this.isGem5O3PipeView_ && this.currentLine_ > GIVING_UP_LINE) {
                throw new Error("The selected file is not a gem5 O3PipeView trace.");
            }
            this.parseExLogLine_(line, args);
        }
        this.currentLine_++;

        this.updateTimer_--;
        if (this.updateTimer_ < 0) {
            this.updateTimer_ = 1024 * 16;
            if (this.isGem5O3PipeView_) {
                this.drainParsingOps_(false);
            }
        }
    }

    private parseExLogLine_(line: string, args: string[]): void {
        // O3PipeView以外でsn:数字を持つ行は、対応する命令のstage処理まで一旦保持する。
        let seqNum = this.parsingExLogLastGID_;
        const matched = SERIAL_NUMBER_PATTERN.exec(line);
        if (matched !== null) {
            seqNum = Number(matched[1]);
            this.parsingExLogLastGID_ = seqNum;
        }

        // seqNumはgem5のglobal IDなので、file-localなOpStore IDではなく、既に
        // drainした最後のglobal IDと比較して確定済み命令の追加ログを破棄する。
        if (this.parsingExLogLastGID_ === -1 || seqNum <= this.lastGID_) {
            return;
        }

        let exLog = this.parsingExLogs_.get(seqNum);
        if (exLog === undefined) {
            exLog = new Gem5O3PipeViewExLogInfo();
            this.parsingExLogs_.set(seqNum, exLog);
        }
        // sequence numberとthread IDが同じ行に明記された場合だけ対応付ける。
        // snを持たないstage全体のログを直前命令へ誤帰属させないためである。
        if (matched !== null) {
            const matchedThreadID = THREAD_ID_PATTERN.exec(line);
            if (matchedThreadID !== null && exLog.threadID === null) {
                exLog.threadID = Number(matchedThreadID[1]);
            }
        }
        if (/^\s*\d+/.test(args[0])) {
            // tickで始まる継続行だけを同じ命令の追加ログとして保存する。
            exLog.logList.push(args);
        }
        else {
            this.parsingExLogLastGID_ = -1;
        }
    }

    private detectTicksPerClock_(force: boolean): void {
        if (this.ticksPerClock_ !== -1) {
            return;
        }

        // 完了した命令に現れた全tickを集め、最小差分を1 clockとして検出する。
        const ticks = new Set<number>();
        let minSeqNum = -1;
        const seqNums = [...this.parsingOps_.keys()].sort((left, right) => left - right);
        for (const seqNum of seqNums) {
            const op = this.parsingOps_.get(seqNum);
            if (op === undefined) {
                continue;
            }
            if (!op.flush && !op.retired) {
                break; // 次の命令はまだ最後まで出力されていない。
            }

            ticks.add(op.fetchedCycle);
            ticks.add(op.retiredCycle);
            for (const lane of op.lanes) {
                if (lane === null) {
                    continue;
                }
                for (const stage of lane.stages) {
                    ticks.add(stage.startCycle);
                    ticks.add(stage.endCycle);
                }
            }
            minSeqNum = minSeqNum === -1 ? seqNum : Math.min(minSeqNum, seqNum);
        }

        const sortedTicks = [...ticks].sort((left, right) => left - right);
        if (!force && sortedTicks.length < 1024) {
            return;
        }
        if (sortedTicks.length < 2 || minSeqNum === -1) {
            return;
        }

        let minDelta = 0;
        let previousTick = sortedTicks[0];
        for (const tick of sortedTicks) {
            const delta = tick - previousTick;
            if (minDelta === 0 || (delta > 0 && delta < minDelta)) {
                minDelta = delta;
            }
            previousTick = tick;
        }

        if (minDelta > 0) {
            this.ticksPerClock_ = minDelta;
            this.cycleBegin_ = sortedTicks[0] / minDelta;
            this.gidBegin_ = minSeqNum;
            console.log(`Detected ticks per clock: ${minDelta}`);
        }
    }

    private drainParsingOps_(force: boolean): void {
        this.detectTicksPerClock_(force);
        if (this.ticksPerClock_ === -1) {
            return;
        }

        // gem5の出力は1万以上seqNumが遡ることがあるため、現行版と同じ量をbufferする。
        const seqNums = [...this.parsingOps_.keys()].sort((left, right) => left - right);
        let drainCount = seqNums.length - BUFFERED_SIZE;
        if (!force && drainCount < 0) {
            return;
        }

        for (const seqNum of seqNums) {
            const op = this.parsingOps_.get(seqNum);
            if (op === undefined) {
                continue;
            }
            if (!force && !op.flush && !op.retired) {
                continue;
            }
            if (!force && drainCount <= 0) {
                break;
            }
            drainCount--;

            this.convertTicksToCycles_(op);
            const id = seqNum - this.gidBegin_;
            this.reorderedOps_.set(id, op);
            this.reorderedLastID_ = Math.max(this.reorderedLastID_, id);
            this.parsingOps_.delete(seqNum);

            if (this.lastGID_ > seqNum) {
                console.log(
                    `Miss parsed op: seqNum: ${seqNum} lastGID: ${this.lastGID_}. ` +
                    "BUFFERED_SIZE must be bigger.",
                );
            }
        }

        // seqNumから求めたfile-local ID順に、表示用storeとRID索引へ登録する。
        for (let id = this.opStore_.lastID + 1; id <= this.reorderedLastID_; id++) {
            const op = this.reorderedOps_.get(id);
            if (op === undefined) {
                continue;
            }
            op.id = id;
            this.reorderedOps_.delete(id);
            // 新しいgem5の明示recordを優先し、旧traceは追加debug logから補う。
            // どちらにも情報がないO3PipeView単独traceは従来互換のthread 0とする。
            if (op.tid === -1) {
                op.tid = this.parsingExLogs_.get(op.gid)?.threadID ?? 0;
            }
            this.opStore_.setOp(id, op);
            this.lastGID_ = op.gid;
            this.currentCycle_ = Math.max(this.currentCycle_, op.retiredCycle);

            if (!op.flush) {
                op.rid = this.opStore_.lastRID + 1;
                this.opStore_.setRetiredOp(op.rid, op);
                this.lastNotFlushedID_ = id;
            }
            else {
                // flush命令にも描画位置計算用のdummy RIDを従来と同じ式で割り当てる。
                op.rid = this.opStore_.lastRID + id - this.lastNotFlushedID_;
            }

            this.postProcessExLog_(op);
            this.opStore_.setOp(id, op);
        }
    }

    private convertTicksToCycles_(op: Op): void {
        op.fetchedCycle = op.fetchedCycle / this.ticksPerClock_ - this.cycleBegin_;
        op.retiredCycle = op.retiredCycle / this.ticksPerClock_ - this.cycleBegin_;
        // fetchだけを実行してflushされた場合も、最低1 cycleはstageを表示する。
        if (op.flush && op.fetchedCycle === op.retiredCycle) {
            op.retiredCycle++;
        }
        if (op.prodCycle !== -1) {
            op.prodCycle = op.prodCycle / this.ticksPerClock_ - this.cycleBegin_;
        }
        if (op.consCycle !== -1) {
            op.consCycle = op.consCycle / this.ticksPerClock_ - this.cycleBegin_;
        }

        for (const lane of op.lanes) {
            if (lane === null) {
                continue;
            }
            for (const stage of lane.stages) {
                stage.startCycle = stage.startCycle / this.ticksPerClock_ - this.cycleBegin_;
                stage.endCycle = stage.endCycle / this.ticksPerClock_ - this.cycleBegin_;
                // retire eventは通常stageとして右端へ1 cycle表示する。生のretire時刻は
                // op.retiredCycleに保持し、命令のretire順や依存線の位置は変えない。
                if (stage.name === STAGE_LABELS.retire && stage.startCycle === stage.endCycle) {
                    stage.endCycle++;
                }
                // Rendererの既存規則を変えず、flushの0-cycle stageも従来どおり広げる。
                else if (op.flush && stage.startCycle === stage.endCycle) {
                    stage.endCycle++;
                }
            }
        }
    }

    private postProcessExLog_(op: Op): void {
        const exLog = this.parsingExLogs_.get(op.gid);
        if (exLog === undefined) {
            return;
        }

        for (const source of exLog.srcs) {
            const producer = this.dependencyTable_.get(source);
            if (producer !== undefined && producer.prodCycle < op.consCycle) {
                const type = 0;
                op.prods.push(new Dependency(producer.id, type, op.prodCycle));
                producer.cons.push(new Dependency(op.id, type, op.consCycle));
                // 圧縮storeから復元されたOpでもconsumer索引を失わないよう書き戻す。
                this.opStore_.setOp(producer.id, producer);
            }
        }
        for (const destination of exLog.dsts) {
            this.dependencyTable_.set(destination, op);
        }
        this.parsingExLogs_.delete(op.gid);
    }

    private parseInitialCommand_(args: string[]): Op {
        // 特定命令の出力開始。6番目以降のコロンも逆アセンブル文字列の一部になる。
        // O3PipeView:fetch:2132747000:0x004ea8f4:0:4:  add   w6, w6, w7
        const tick = this.parseNumber_(args[2], "fetch tick");
        const address = args[3] ?? "";
        const microPC = this.parseNumber_(args[4], "fetch micro PC");
        const seqNum = this.parseNumber_(args[5], "fetch sequence number");
        const disassembly = args.slice(6).join(":");

        const op = new Op();
        op.id = -1; // seqNum順への並べ直しが終わるまでは未定。
        op.gid = seqNum;
        op.fetchedCycle = tick;
        op.line = this.currentLine_;
        op.labelName = `${address}: ${disassembly}`;
        op.labelDetail = `Fetched Tick: ${tick}\nMicro PC: ${microPC}`;
        this.parsingOps_.set(seqNum, op);

        this.currentSeqNum_ = seqNum;
        this.currentInstructionFlushed_ = false;
        this.currentInstructionTick_ = tick;
        this.parseStartCommand_(op, args);
        return op;
    }

    private parseStartCommand_(op: Op, args: string[]): void {
        // fetch以外は命令番号を持たず、直前のfetchが作ったcontextへstageを追加する。
        const command = args[1] ?? "";
        const tick = this.parseNumber_(args[2], `${command} tick`);
        const stageName = STAGE_LABELS[command];
        if (stageName === undefined) {
            return;
        }

        // 中間stageのtick 0はtimestampが記録されなかったことを表す。
        // flushかどうかはretire recordのtickだけで判定する。
        if (tick === 0) {
            return;
        }
        this.currentInstructionTick_ = tick;

        const laneName = "0";
        const laneID = this.stageLevelMap_.getOrCreateLaneID(laneName);
        const lane = getOrCreateLane(op, laneID);
        const stage = new Stage();
        stage.name = stageName;
        stage.startCycle = tick;
        lane.stages.push(stage);
        op.lastParsedLaneID = laneID;
        op.lastParsedStageID = lane.stages.length - 1;
        op.lastParsedCycle = tick;

        // Cmを実行stageと見なし、依存線の消費・生成位置として使う。
        if (stageName === "Cm") {
            op.consCycle = tick;
            op.prodCycle = tick;
        }
        // 現行版が将来のmemory write stage用に持つ判定もそのまま残す。
        if (stageName === "Mw") {
            op.prodCycle = tick;
        }

        this.stageLevelMap_.update(laneName, stageName, lane);
    }

    private parseEndCommand_(op: Op, args: string[]): void {
        const tick = this.parseNumber_(args[2], `${args[1] ?? "stage"} tick`);
        if (tick === 0) {
            // 対応するstage timestampがない場合は、直前stageを次の有効tickまで開いておく。
            return;
        }

        const lane = op.lanes[op.lastParsedLaneID];
        const stage = getLastParsedStage(op);
        if (lane === null || lane === undefined || stage === null) {
            return;
        }
        op.lastParsedCycle = tick;
        stage.endCycle = tick;

        // flushで無理に閉じられる場合があるため、StageLevelMapへの登録はstart側で行う。
        if (stage.startCycle !== stage.endCycle) {
            lane.level++;
        }
    }

    private parseRetireCommand_(op: Op, args: string[]): void {
        const retireTick = this.parseNumber_(args[2], "retire tick");
        let tick = retireTick;
        if (retireTick === 0) {
            this.currentInstructionFlushed_ = true;
            tick = this.currentInstructionTick_;
        }
        op.labelDetail += `\nRetired Tick: ${retireTick}`;
        for (let index = 3; index + 1 < args.length; index += 2) {
            if (args[index] !== "store") {
                continue;
            }
            const storeTick = this.parseNumber_(args[index + 1], "store completion tick");
            op.labelDetail += `\nStore Tick: ${storeTick}`;
        }
        op.retiredCycle = tick;
        op.lastParsedCycle = tick;
        op.flush = this.currentInstructionFlushed_;
        op.retired = !op.flush;

        // 閉じていないstageはretireまたはflush tickで閉じる。
        for (const lane of op.lanes) {
            if (lane === null) {
                continue;
            }
            for (const stage of lane.stages) {
                if (stage.endCycle === 0) {
                    stage.endCycle = tick;
                    if (stage.startCycle !== tick) {
                        lane.level++;
                    }
                }
            }
        }

        // retire eventはcycle変換時に1 cycleへ広げる通常のRt stageとして保持する。
        if (!op.flush) {
            const laneName = "0";
            const laneID = this.stageLevelMap_.getOrCreateLaneID(laneName);
            const lane = getOrCreateLane(op, laneID);
            const stage = new Stage();
            stage.name = STAGE_LABELS.retire;
            stage.startCycle = tick;
            stage.endCycle = tick;
            lane.stages.push(stage);
            this.stageLevelMap_.update(laneName, stage.name, lane);
        }
    }

    private parseCommand_(args: string[]): void {
        const command = args[1];
        if (command === "fetch") {
            this.parseInitialCommand_(args);
            return;
        }

        const op = this.parsingOps_.get(this.currentSeqNum_);
        if (op === undefined) {
            throw new Error(`Line ${this.currentLine_}: ${String(command)} has no current instruction.`);
        }
        if (command === "thread") {
            // args[2]を従来commandと同じtick位置に置くことで、未知commandを
            // 無視する旧O3PipeView toolでもtickによる読み飛ばしを壊さない。
            this.parseNumber_(args[2], "thread tick");
            const threadID = this.parseNumber_(args[3], "thread ID");
            if (!Number.isInteger(threadID) || threadID < 0) {
                throw new Error(`Line ${this.currentLine_}: thread ID is not a non-negative integer.`);
            }
            op.tid = threadID;
            return;
        }
        const tick = this.parseNumber_(args[2], `${String(command)} tick`);
        switch (command) {
        case "decode":
        case "rename":
        case "dispatch":
        case "issue":
        case "complete":
            this.parseExLog_(op, tick);
            if (tick !== 0 && tick < this.currentInstructionTick_) {
                // issueTickはreplayのたびに上書きされる一方、completeTickは以前の完了を
                // 保持する場合がある。raw値はdetailへ残し、pipeline stageだけを単調化する。
                op.labelDetail +=
                    `\nOut-of-order ${String(command)} Tick: ${tick}` +
                    ` (normalized to ${this.currentInstructionTick_})`;
                const normalizedArgs = [...args];
                normalizedArgs[2] = String(this.currentInstructionTick_);
                this.parseEndCommand_(op, normalizedArgs);
                this.parseStartCommand_(op, normalizedArgs);
            }
            else {
                this.parseEndCommand_(op, args);
                this.parseStartCommand_(op, args);
            }
            break;
        case "retire":
            // 追加ログの格納順はtick順とは限らない。全件を回収し、各event tickが
            // retireより前かどうかでMc stage化の可否を個別に決める。
            this.parseExLog_(
                op,
                Number.POSITIVE_INFINITY,
                tick === 0 ? this.currentInstructionTick_ : tick,
            );
            this.parseRetireCommand_(op, args);
            this.unescapeLabels_(op);
            break;
        }
    }

    private parseExLog_(
        op: Op,
        parseCycleRange: number,
        memoryStageCutoff = parseCycleRange,
    ): void {
        // 追加ログ処理でstageを増やす場合があるため、O3PipeView commandと同期して消費する。
        const exLog = this.parsingExLogs_.get(op.gid);
        if (exLog === undefined) {
            return;
        }

        while (exLog.logList.length > 0) {
            const args = exLog.logList[0];
            const tick = args[0];
            // 中間stageと同tickのlogは次の境界まで待ち、従来のstage分割を維持する。
            // retire時だけInfinityで呼ぶため、そこで同tick・retire後を含む全残件を回収できる。
            if (Number(tick) >= parseCycleRange) {
                break;
            }

            let labelStage = getLastParsedStage(op);
            if (args[1] === " user") {
                // register values: 3260000: user: ...
                op.labelDetail += `\n ${args.join(":")}`;
            }
            else if (args[1] === " global" && args[2] === " RegFile") {
                // 3260000: global: RegFile: Setting int register 125 to 0x4af000
                op.labelDetail += `\n ${args[3] ?? ""}`;
            }
            else if (/\.memDep/.test(args[1] ?? "") && / Completed mem/.test(args[2] ?? "")) {
                // retire以降または現在のpipeline時刻より前へ遡るeventはstageへせず、
                // raw情報だけを残す。単調なretire前eventは従来のMc stageを維持する。
                op.labelDetail += `\n Memory Complete: ${args.join(":")}`;
                const memoryTick = Number(tick);
                if (memoryTick >= this.currentInstructionTick_ && memoryTick < memoryStageCutoff) {
                    const stageArgs = ["O3PipeView", "mem_complete", tick];
                    this.parseEndCommand_(op, stageArgs);
                    this.parseStartCommand_(op, stageArgs);
                    labelStage = getLastParsedStage(op);
                }
            }
            else if (/\.rename/.test(args[1] ?? "")) {
                // コロン数が変わるため、rename情報が入るtokenを順に探す。
                for (let index = 2; index < args.length; index++) {
                    const text = args[index];
                    if (!/ (Renaming)|(Looking)/.test(text)) {
                        continue;
                    }
                    op.labelDetail += `\n ${text}`;

                    const destination = text.match(/\(([^()]+)\) to physical reg (\d+) \(\d+\)/);
                    if (destination !== null) {
                        const registerClass = destination[1].trim();
                        if (registerClass !== "invalid") {
                            exLog.dsts.push(`${registerClass}${destination[2]}`);
                        }
                    }
                    const source = text.match(/got phys reg (\d+) \(([^()]+)\)/);
                    if (source !== null) {
                        const registerClass = source[2].trim();
                        if (registerClass !== "invalid") {
                            exLog.srcs.push(`${registerClass}${source[1]}`);
                        }
                    }
                }
            }
            else if (
                /\.iew\.lsq\.thread/.test(args[1] ?? "") &&
                / (Read called)|(Doing write)/.test(args[2] ?? "")
            ) {
                // load/store addressを詳細ラベルへ残す。
                op.labelDetail += `\n ${args.slice(2, 7).join(":")}`;
            }

            // 追加ログ原文は、その時点で開いているstageのtooltipにも残す。
            if (labelStage !== null) {
                if (labelStage.labels !== "") {
                    labelStage.labels += "\n";
                }
                labelStage.labels += args.join(":");
            }
            exLog.logList.shift();
        }
    }

    private unescapeLabels_(op: Op): void {
        // 文字列としての\nを表示用改行へ戻す。replaceはV8のcons string平坦化も兼ねる。
        op.labelName = op.labelName.replace(/\\n/g, "\n");
        op.labelDetail = op.labelDetail.replace(/\\n/g, "\n");
        for (const lane of op.lanes) {
            if (lane === null) {
                continue;
            }
            for (const stage of lane.stages) {
                stage.labels = stage.labels.replace(/\\n/g, "\n");
            }
        }
    }

    private parseNumber_(text: string | undefined, field: string): number {
        const value = text === undefined || text.trim() === "" ? Number.NaN : Number(text);
        if (!Number.isFinite(value)) {
            throw new Error(`Line ${this.currentLine_}: ${field} is not a valid number.`);
        }
        return value;
    }
}
