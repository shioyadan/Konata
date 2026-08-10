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

class TraceCommandError extends Error {}

export class OnikiriParser {
    readonly name = "OnikiriParser";
    // Rをまだ受け取っていない命令と、表示対象として確定した命令を分けて保持する。
    private readonly activeOps_ = new Map<number, Op>();
    private readonly laneNames_ = new Set<string>();
    private readonly stageLevelMap_ = new StageLevelMap();
    // 現在の行番号と、現在読み出し中のcycle。
    private currentLine_ = 1;
    private currentCycle_ = 0;
    // 壊れた入力でconsoleを埋めないよう、警告表示は先頭だけに制限する。
    private warningCount_ = 0;

    constructor(private readonly opStore_: MutableOpStore = new ArrayOpStore()) {}

    async parse(
        file: File,
        onProgress?: ProgressCallback,
        onUpdate?: TraceUpdateCallback,
        signal?: AbortSignal,
    ): Promise<ParsedTrace> {
        const reader = new FileLineReader(file);
        // lane setとstoreを複製せず、読み込み完了後まで同じtraceを段階更新する。
        const trace = new ParsedTrace(
            file.name,
            this.opStore_,
            this.laneNames_,
            this.stageLevelMap_,
            this.currentCycle_,
        );
        let formatConfirmed = false;
        const updateTrace = () => {
            trace.updateLastCycle(this.currentCycle_);
            onUpdate?.(trace);
        };

        await reader.readLines(
            (line) => {
                // FileLineReaderは同じ入力chunk内の行を同期的に渡す。ここをasyncにすると
                // 行ごとのPromiseを再び作るため、parseLine_まで同じcall stackで完了させる。
                this.parseLine_(line);
                if (!formatConfirmed) {
                    // 先頭headerが受理されるまで公開せず、gem5 fallback時に空のKanata traceを見せない。
                    formatConfirmed = true;
                    updateTrace();
                }
            },
            (progress) => {
                onProgress?.(progress);
                if (formatConfirmed) {
                    updateTrace();
                }
            },
            signal,
        );
        if (reader.canceled) {
            // 呼び出し側へ返らないtraceはParser側で解放する。Tab側ですでに閉じていてもcloseは安全である。
            trace.close();
            throw new Error("File loading was canceled.");
        }
        if (this.currentLine_ === 1) {
            throw new Error("The selected file is empty.");
        }

        this.finish_();
        updateTrace();
        return trace;
    }

    private parseLine_(line: string): void {
        if (this.currentLine_ === 1 && !/^Kanata/.test(line)) {
            throw new Error("The selected file is not a Kanata trace.");
        }

        const args = line.split("\t");
        try {
            this.parseCommand_(args);
        }
        catch (error) {
            // 1行の破損で残りのtraceを失わず、安全に無視できるcommand errorは警告に留める。
            if (error instanceof TraceCommandError) {
                this.warning_(error.message);
            }
            else {
                throw error;
            }
        }
        this.currentLine_++;
    }

    private parseCommand_(args: string[]): void {
        const command = args[0];
        if (command === "Kanata" || command === "C=") {
            return;
        }
        if (command === "C") {
            this.requireArguments_(args, 2, command);
            this.currentCycle_ += this.parseInteger_(args[1], command);
            return;
        }
        if (command.length !== 1 || !"ILSERW".includes(command)) {
            // 旧Parserと同じく、改行を含むlabelの後半など未知の行は警告して読み飛ばす。
            this.warning_(`Unknown command: ${command}`);
            return;
        }

        this.requireArguments_(args, 2, command);
        const id = this.parseInteger_(args[1], command);
        const activeOp = this.activeOps_.get(id);
        // Iの再定義検出にも必要なため、command種別によらず完了済みstoreを確認する。
        const storedOp = activeOp === undefined ? this.opStore_.getOp(id) : undefined;
        const op = activeOp ?? storedOp;
        const parsedOpUsed = storedOp !== undefined && command !== "I";
        if (op !== undefined && parsedOpUsed) {
            // 現行版はretire後の追加ラベルを警告しつつ保持する。
            this.warning_(`Command appears after op ${id} was retired or flushed.`);
        }

        switch (command) {
        case "I":
            this.parseInitialCommand_(id, op, args);
            break;
        case "L":
            this.parseLabelCommand_(id, op, args);
            break;
        case "S":
            this.parseStartCommand_(id, op, args);
            break;
        case "E":
            this.parseEndCommand_(id, op, args);
            break;
        case "R":
            this.parseRetireCommand_(id, op, args);
            break;
        case "W":
            this.parseDependencyCommand_(id, op, args);
            break;
        }

        // 将来の圧縮storeは複製を返し得るため、retire後のOpを変更した場合は再設定する。
        if (parsedOpUsed && op !== undefined) {
            this.opStore_.setOp(id, op);
        }
    }

    private parseInitialCommand_(id: number, op: Op | undefined, args: string[]): void {
        // 特定の命令に関するコマンド出力の開始。
        // 形式: I <file-local ID> <simulator global ID> <thread ID>
        // 後続のL/S/E/R/Wは、ここで宣言したfile-local IDで命令を指定する。
        this.requireArguments_(args, 4, "I");
        if (op !== undefined) {
            this.fail_(`${id} is redefined by an I command.`);
        }

        const created = new Op();
        created.id = id;
        created.gid = this.parseInteger_(args[2], "I");
        created.tid = this.parseInteger_(args[3], "I");
        created.fetchedCycle = this.currentCycle_;
        created.line = this.currentLine_;
        this.activeOps_.set(id, created);
    }

    private parseLabelCommand_(id: number, op: Op | undefined, args: string[]): void {
        // 命令が生きている間はLを複数回指定でき、既存ラベルへ追記される。
        // type 0は左pane、1は詳細表示、2は現在のstageに使う。
        this.requireArguments_(args, 4, "L");
        const target = this.requireOp_(id, op, "L");
        const type = this.parseInteger_(args[2], "L");
        const label = args[3];

        if (type === 0) {
            target.labelName += label;
        }
        else if (type === 1) {
            target.labelDetail += label;
        }
        else if (type === 2) {
            if (target.lastParsedStage === null) {
                this.fail_(`The L command for op ${id} has no current stage.`);
            }
            if (target.lastParsedStage.labels !== "") {
                target.lastParsedStage.labels += "\n";
            }
            target.lastParsedStage.labels += label;
        }
    }

    private parseStartCommand_(id: number, op: Op | undefined, args: string[]): void {
        this.requireArguments_(args, 4, "S");
        const target = this.requireOp_(id, op, "S");
        const laneName = this.parseName_(args[2]);
        const stageName = this.parseName_(args[3]);
        let lane = target.lanes.get(laneName);
        if (lane === undefined) {
            lane = new Lane();
            target.lanes.set(laneName, lane);
        }

        // 同じlaneの最後のstageが閉じられていなければ、新しいSのcycleで自動的に閉じる。
        const previous = lane.stages[lane.stages.length - 1];
        if (previous !== undefined && previous.endCycle === 0) {
            this.closeStage_(id, laneName, previous.name, target);
        }

        const stage = new Stage();
        stage.name = stageName;
        stage.startCycle = this.currentCycle_;
        lane.stages.push(stage);
        target.lastParsedStage = stage;

        // 名前にXを含むstageを実行stageと見なし、依存線の始点に用いる。
        if (/X/.test(stageName)) {
            target.consCycle = this.currentCycle_;
        }
        this.laneNames_.add(laneName);
        this.stageLevelMap_.update(laneName, stageName, lane);
    }

    private parseEndCommand_(id: number, op: Op | undefined, args: string[]): void {
        this.requireArguments_(args, 4, "E");
        const target = this.requireOp_(id, op, "E");
        this.closeStage_(id, this.parseName_(args[2]), this.parseName_(args[3]), target);
    }

    private closeStage_(id: number, laneName: string, stageName: string, op: Op): void {
        const lane = op.lanes.get(laneName);
        if (lane === undefined) {
            this.fail_(`Lane ${laneName} is not defined for op ${id}.`);
        }

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

        stage.endCycle = this.currentCycle_;
        // flushで無理に閉じられる場合があるので、StageLevelMapへの登録はS側で行う。
        if (stage.startCycle !== stage.endCycle) {
            lane.level++;
        }
        if (/X/.test(stageName)) {
            op.prodCycle = this.currentCycle_ - 1;
        }
    }

    private parseRetireCommand_(id: number, op: Op | undefined, args: string[]): void {
        this.requireArguments_(args, 4, "R");
        const target = this.requireOp_(id, op, "R");
        const rid = this.parseInteger_(args[2], "R");
        const flush = this.parseInteger_(args[3], "R") === 1;
        // 全fieldの検査後に反映し、不正なRを警告した場合に途中状態を残さない。
        target.rid = rid;
        target.retiredCycle = this.currentCycle_;
        target.flush = flush;
        target.retired = !flush;

        // 閉じていない最後のstageはretire/flush cycleで閉じる。
        for (const lane of target.lanes.values()) {
            const stage = lane.stages[lane.stages.length - 1];
            if (stage === undefined) {
                continue;
            }
            if (stage.endCycle === 0) {
                stage.endCycle = this.currentCycle_;
            }
            if (/X/.test(stage.name)) {
                target.prodCycle = this.currentCycle_ - 1;
            }
        }

        this.unescapeLabels_(target);
        // パース完了によりactive側から表示対象の配列へ移す。
        this.activeOps_.delete(id);
        this.opStore_.setOp(id, target);
        if (!target.flush) {
            this.opStore_.setRetiredOp(target.rid, target);
        }
    }

    private parseDependencyCommand_(id: number, op: Op | undefined, args: string[]): void {
        // 任意の依存関係。典型的にはwake-upを表す。
        // 形式: W <consumer ID> <producer ID> <type>
        // type 0がwake-upで、1以降は拡張用としてproducer/consumer双方へ記録する。
        this.requireArguments_(args, 4, "W");
        const consumer = this.requireOp_(id, op, "W");
        const producerID = this.parseInteger_(args[2], "W");
        const activeProducer = this.activeOps_.get(producerID);
        const producer = activeProducer ?? this.opStore_.getOp(producerID);
        if (producer === undefined) {
            this.fail_(`The W command refers to undefined producer ${producerID}.`);
        }
        const type = this.parseInteger_(args[3], "W");
        consumer.prods.push(new Dependency(producer.id, type, this.currentCycle_));
        producer.cons.push(new Dependency(consumer.id, type, this.currentCycle_));
        if (activeProducer === undefined) {
            // producerが圧縮storeから復元された複製でもconsumer索引を失わないよう書き戻す。
            this.opStore_.setOp(producer.id, producer);
        }
    }

    private finish_(): void {
        // retireされずにEOFへ達した命令も、既存版と同じく表示対象として残す。
        for (const [id, op] of this.activeOps_) {
            op.retiredCycle = this.currentCycle_ + 1;
            op.eof = true;
            this.unescapeLabels_(op);
            this.opStore_.setOp(id, op);
        }
        this.activeOps_.clear();
    }

    private unescapeLabels_(op: Op): void {
        // ラベル中の文字列としての\\nを、表示用の改行へ戻す。
        // 文字列結合で生じるV8のcons stringもreplaceにより平坦化されるため、
        // 旧実装では命令あたりのメモリ使用量を抑える効果も担っていた。
        op.labelName = op.labelName.replace(/\\n/g, "\n");
        op.labelDetail = op.labelDetail.replace(/\\n/g, "\n");
        for (const lane of op.lanes.values()) {
            for (const stage of lane.stages) {
                stage.labels = stage.labels.replace(/\\n/g, "\n");
            }
        }
    }

    private requireArguments_(args: string[], count: number, command: string): void {
        if (args.length < count) {
            this.fail_(`${command} requires ${count} fields, but ${args.length} were provided.`);
        }
    }

    private requireOp_(id: number, op: Op | undefined, command: string): Op {
        if (op === undefined) {
            this.fail_(`${command} refers to undefined op ${id}.`);
        }
        return op;
    }

    private parseInteger_(text: string | undefined, command: string): number {
        const normalized = text?.trim();
        const value = normalized === undefined || normalized === "" ? Number.NaN : Number(normalized);
        if (!Number.isFinite(value)) {
            this.fail_(`${command} contains an invalid number: ${String(text)}`);
        }
        return value;
    }

    private parseName_(text: string | undefined): string {
        return text?.trim() ?? "";
    }

    private warning_(message: string): void {
        this.warningCount_++;
        if (this.warningCount_ < 10) {
            console.warn(`Warning at line ${this.currentLine_}: ${message}`);
        }
        else if (this.warningCount_ === 10) {
            console.warn("Too many parser warnings; further warnings are omitted.");
        }
    }

    private fail_(message: string): never {
        throw new TraceCommandError(message);
    }
}
