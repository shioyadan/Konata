import { FileLineReader, type ProgressCallback } from "./file_line_reader";
import {
    Dependency,
    Lane,
    Op,
    ParsedTrace,
    Stage,
    StageLevelMap,
    type TraceUpdateCallback,
} from "./model";
import { ArrayOpStore, type MutableOpStore } from "./op_store";

class Gem5O3PipeViewExLogInfo {
    readonly logList: string[][] = [];
    readonly srcs: string[] = [];
    readonly dsts: string[] = [];
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
    // 追加ログの解析結果から作られるmemory complete stage。
    mem_complete: "Mc",
};
const SERIAL_NUMBER_PATTERN = /sn:(\d+)/;

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

    private readonly laneNames_ = new Set<string>();
    private readonly stageLevelMap_ = new StageLevelMap();
    private ticksPerClock_ = -1;
    private cycleBegin_ = -1;
    private gidBegin_ = -1;
    private isGem5O3PipeView_ = false;
    // 現行版と同じく、最初は100行、その後は16K行ごとに完了命令をdrainする。
    private updateTimer_ = 100;

    constructor(private readonly opStore_: MutableOpStore = new ArrayOpStore()) {}

    async parse(
        file: File,
        onProgress?: ProgressCallback,
        onUpdate?: TraceUpdateCallback,
        signal?: AbortSignal,
    ): Promise<ParsedTrace> {
        const reader = new FileLineReader(file);
        const trace = new ParsedTrace(
            file.name,
            this.opStore_,
            this.laneNames_,
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

        // 現行版は既にdrainしたID以下の追加ログを破棄する。
        if (this.parsingExLogLastGID_ === -1 || seqNum <= this.opStore_.lastID) {
            return;
        }

        let exLog = this.parsingExLogs_.get(seqNum);
        if (exLog === undefined) {
            exLog = new Gem5O3PipeViewExLogInfo();
            this.parsingExLogs_.set(seqNum, exLog);
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
            for (const lane of op.lanes.values()) {
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

        for (const lane of op.lanes.values()) {
            for (const stage of lane.stages) {
                stage.startCycle = stage.startCycle / this.ticksPerClock_ - this.cycleBegin_;
                stage.endCycle = stage.endCycle / this.ticksPerClock_ - this.cycleBegin_;
                // flushで同一cycleになったstageにも最低1 cycleの幅を持たせる。
                if (op.flush && stage.startCycle === stage.endCycle) {
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
        const seqNum = this.parseNumber_(args[5], "fetch sequence number");
        const disassembly = args.slice(6).join(":");

        const op = new Op();
        op.id = -1; // seqNum順への並べ直しが終わるまでは未定。
        op.gid = seqNum;
        op.tid = 0;
        op.fetchedCycle = tick;
        op.line = this.currentLine_;
        op.labelName = `${address}: ${disassembly}`;
        op.labelDetail = `Fetched Tick: ${tick}`;
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
        let tick = this.parseNumber_(args[2], `${command} tick`);
        const stageName = STAGE_LABELS[command];
        if (stageName === undefined) {
            return;
        }

        // tick 0はflushを表す。最後の有効tickを記録し、それ以降のstageは作らない。
        if (tick === 0) {
            this.currentInstructionFlushed_ = true;
            tick = this.currentInstructionTick_;
            return;
        }
        this.currentInstructionTick_ = tick;

        const laneName = "0";
        let lane = op.lanes.get(laneName);
        if (lane === undefined) {
            lane = new Lane();
            op.lanes.set(laneName, lane);
        }
        const stage = new Stage();
        stage.name = stageName;
        stage.startCycle = tick;
        lane.stages.push(stage);
        op.lastParsedStage = stage;
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

        this.laneNames_.add(laneName);
        this.stageLevelMap_.update(laneName, stageName, lane);
    }

    private parseEndCommand_(op: Op, args: string[]): void {
        const tick = this.parseNumber_(args[2], `${args[1] ?? "stage"} tick`);
        if (tick === 0 && this.currentInstructionFlushed_) {
            // flush後のstageは作られていないため、対応するcloseも無視する。
            return;
        }

        const lane = op.lanes.get("0");
        const stageName = op.lastParsedStage?.name;
        if (lane === undefined || stageName === undefined) {
            return;
        }
        op.lastParsedCycle = tick;

        let stage: Stage | undefined;
        for (let index = lane.stages.length - 1; index >= 0; index--) {
            if (lane.stages[index].name === stageName) {
                stage = lane.stages[index];
                break;
            }
        }
        if (stage === undefined) {
            return;
        }
        stage.endCycle = tick;

        // flushで無理に閉じられる場合があるため、StageLevelMapへの登録はstart側で行う。
        if (stage.startCycle !== stage.endCycle) {
            lane.level++;
        }
    }

    private parseRetireCommand_(op: Op, args: string[]): void {
        let tick = this.parseNumber_(args[2], "retire tick");
        if (tick === 0) {
            this.currentInstructionFlushed_ = true;
            tick = this.currentInstructionTick_;
        }
        op.retiredCycle = tick;
        op.lastParsedCycle = tick;
        op.flush = this.currentInstructionFlushed_;
        op.retired = !op.flush;
        this.unescapeLabels_(op);

        // 閉じていないstageはretireまたはflush tickで閉じる。
        for (const lane of op.lanes.values()) {
            for (const stage of lane.stages) {
                if (stage.endCycle === 0) {
                    stage.endCycle = tick;
                }
            }
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
        const tick = this.parseNumber_(args[2], `${String(command)} tick`);
        switch (command) {
        case "decode":
        case "rename":
        case "dispatch":
        case "issue":
        case "complete":
            this.parseExLog_(op, tick);
            this.parseEndCommand_(op, args);
            this.parseStartCommand_(op, args);
            break;
        case "retire":
            this.parseExLog_(op, tick);
            this.parseRetireCommand_(op, args);
            break;
        }
    }

    private parseExLog_(op: Op, parseCycleRange: number): void {
        // 追加ログ処理でstageを増やす場合があるため、O3PipeView commandと同期して消費する。
        const exLog = this.parsingExLogs_.get(op.gid);
        if (exLog === undefined) {
            return;
        }

        while (exLog.logList.length > 0) {
            const args = exLog.logList[0];
            const tick = args[0];
            if (Number(tick) >= parseCycleRange) {
                break;
            }

            if (args[1] === " user") {
                // register values: 3260000: user: ...
                op.labelDetail += `\n ${args.join(":")}`;
            }
            else if (args[1] === " global" && args[2] === " RegFile") {
                // 3260000: global: RegFile: Setting int register 125 to 0x4af000
                op.labelDetail += `\n ${args[3] ?? ""}`;
            }
            else if (/\.memDep/.test(args[1] ?? "") && / Completed mem/.test(args[2] ?? "")) {
                // memory write backを独立したstageとして挿入する。
                const stageArgs = ["O3PipeView", "mem_complete", tick];
                this.parseEndCommand_(op, stageArgs);
                this.parseStartCommand_(op, stageArgs);
            }
            else if (/\.rename/.test(args[1] ?? "")) {
                // コロン数が変わるため、rename情報が入るtokenを順に探す。
                for (let index = 2; index < args.length; index++) {
                    const text = args[index];
                    if (!/ (Renaming)|(Looking)/.test(text)) {
                        continue;
                    }
                    op.labelDetail += `\n ${text}`;

                    const destination = text.match(/\(([a-zA-Z]+)\) to physical reg (\d+) \(\d+\)/);
                    if (destination !== null && destination[2] !== "invalid") {
                        exLog.dsts.push(`${destination[1]}${destination[2]}`);
                    }
                    const source = text.match(/got phys reg (\d+) \(([a-zA-Z]+)\)/);
                    if (source !== null && source[2] !== "invalid") {
                        exLog.srcs.push(`${source[2]}${source[1]}`);
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
            if (op.lastParsedStage !== null) {
                if (op.lastParsedStage.labels !== "") {
                    op.lastParsedStage.labels += "\n";
                }
                op.lastParsedStage.labels += args.join(":");
            }
            exLog.logList.shift();
        }
    }

    private unescapeLabels_(op: Op): void {
        // 文字列としての\nを表示用改行へ戻す。replaceはV8のcons string平坦化も兼ねる。
        op.labelName = op.labelName.replace(/\\n/g, "\n");
        op.labelDetail = op.labelDetail.replace(/\\n/g, "\n");
        for (const lane of op.lanes.values()) {
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
