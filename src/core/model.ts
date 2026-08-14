import type { OpStore } from "./op_store";

export class Stage {
    name = "";
    labels = "";
    startCycle = 0;
    endCycle = 0;
}

export class Lane {
    // 1サイクル以上のステージ数。既存版と同じ色の出現順計算に利用する。
    level = 0;
    readonly stages: Stage[] = [];
}

export class Dependency {
    constructor(
        readonly opID: number,
        readonly type: number,
        readonly cycle: number,
    ) {}
}

export class Op {
    // ファイル内でのID。Konata内ではこのIDによって命令を識別する。
    id = -1;
    // シミュレータ上のグローバルID、リタイアID、スレッドID。
    gid = -1;
    rid = -1;
    tid = -1;
    // 正常リタイアか、flushによる終了かを区別する。
    retired = false;
    flush = false;
    // Rコマンドがないままファイル終端へ達した命令を表す。
    eof = false;
    // lane名はtrace全体で一度だけIDへ変換し、各OpはそのIDをindexとするdataだけを持つ。
    // laneを持たないindexはnullとし、JSON round-tripの前後で同じ配列形状を維持する。
    readonly lanes: Array<Lane | null> = [];
    fetchedCycle = -1;
    retiredCycle = -1;
    // Iコマンドが現れた行番号。
    line = 0;
    // 左の逆アセンブルpaneと、詳細表示用のラベル。
    labelName = "";
    labelDetail = "";
    // type=2のLコマンドを直前のstageへ結び付ける。Stageそのものを参照せず、
    // lanesとstagesの配列indexだけを持つため、そのままJSONへ保存できる。
    lastParsedLaneID = -1;
    lastParsedStageID = -1;
    // gem5 Parserが命令ごとの最終tickを追跡するための値も、共通モデルに維持する。
    lastParsedCycle = -1;
    // 描画はconsumerからproducerへ依存線を引くため、producer IDだけをconsumer側に持つ。
    // 逆向きの索引は、確定・圧縮済みのproducerをWコマンドのたびに更新する必要が生じるため持たない。
    readonly prods: Dependency[] = [];
    // 依存線を実行stageの始点と終点へ描くために使用する。
    prodCycle = -1;
    consCycle = -1;
}

export function getOrCreateLane(op: Op, laneID: number): Lane {
    // 新しいlane IDが途中で増えても、未使用indexを明示的なnullで埋める。配列の穴は
    // JSON.stringifyでnullになるため、最初から同じdata形状にしておく。
    while (op.lanes.length <= laneID) {
        op.lanes.push(null);
    }
    let lane = op.lanes[laneID];
    if (lane === null) {
        lane = new Lane();
        op.lanes[laneID] = lane;
    }
    return lane;
}

export function getLastParsedStage(op: Op): Stage | null {
    if (op.lastParsedLaneID < 0 || op.lastParsedStageID < 0) {
        return null;
    }
    return op.lanes[op.lastParsedLaneID]?.stages[op.lastParsedStageID] ?? null;
}

export interface StageLevel {
    // 同一lane中で最初に現れた段数。
    appearance: number;
    // 同一lane中で異なるstage名ごとに割り当てる段数。
    unique: number;
}

export class StageLevelMap {
    private readonly levels_ = new Map<string, Map<string, StageLevel>>();
    private readonly laneNames_: string[] = [];
    private readonly laneIDs_ = new Map<string, number>();
    private readonly lanePositions_: number[] = [];

    getOrCreateLaneID(laneName: string): number {
        const current = this.laneIDs_.get(laneName);
        if (current !== undefined) {
            return current;
        }

        // 保存用IDは初出時に固定する。表示順は別に再計算するため、読み込み途中で
        // 名前順が変わっても、既存Opのlanes indexを書き換える必要はない。
        const laneID = this.laneNames_.length;
        this.laneNames_.push(laneName);
        this.laneIDs_.set(laneName, laneID);
        [...this.laneNames_].sort().forEach((name, position) => {
            const sortedLaneID = this.laneIDs_.get(name);
            if (sortedLaneID !== undefined) {
                this.lanePositions_[sortedLaneID] = position;
            }
        });
        return laneID;
    }

    update(laneName: string, stageName: string, lane: Lane): void {
        this.getOrCreateLaneID(laneName);
        let laneLevels = this.levels_.get(laneName);
        if (laneLevels === undefined) {
            laneLevels = new Map<string, StageLevel>();
            this.levels_.set(laneName, laneLevels);
        }

        const current = laneLevels.get(stageName);
        if (current !== undefined) {
            current.appearance = Math.min(current.appearance, lane.level);
            return;
        }

        laneLevels.set(stageName, {
            appearance: lane.level,
            unique: laneLevels.size,
        });
    }

    get(laneName: string, stageName: string): StageLevel | undefined {
        return this.levels_.get(laneName)?.get(stageName);
    }

    has(laneName: string, stageName: string): boolean {
        return this.levels_.get(laneName)?.has(stageName) ?? false;
    }

    getStageNames(laneName: string): readonly string[] {
        // Parserが記録した初出順を保ち、設定UIが命令列全体を再走査せずに利用できるようにする。
        return [...(this.levels_.get(laneName)?.keys() ?? [])];
    }

    getLaneID(laneName: string): number | undefined {
        return this.laneIDs_.get(laneName);
    }

    getLaneName(laneID: number): string | undefined {
        return this.laneNames_[laneID];
    }

    getLanePosition(laneID: number): number {
        return this.lanePositions_[laneID] ?? 0;
    }

    get laneNames(): readonly string[] {
        return this.laneNames_;
    }

    get laneNum(): number {
        return this.laneIDs_.size;
    }
}

export class ParsedTrace {
    private warningCount_ = 0;
    // 通常Tabと比較Tabが同じOpStoreを共有する。各表示から直接Storeをcloseすると、
    // 片方を閉じただけで残った表示も壊れるため、Traceを共有所有の境界にする。
    private referenceCount_ = 1;

    constructor(
        readonly fileName: string,
        readonly opStore: OpStore,
        readonly stageLevelMap: StageLevelMap,
        private lastCycle_: number,
    ) {}

    get laneNames(): readonly string[] {
        return this.stageLevelMap.laneNames;
    }

    get lastCycle(): number {
        return this.lastCycle_;
    }

    // 読み込み途中も同じtraceをRendererへ渡すため、Parserが確定済みcycleを更新する。
    updateLastCycle(lastCycle: number): void {
        this.lastCycle_ = lastCycle;
    }

    get warningCount(): number {
        return this.warningCount_;
    }

    // 復旧可能な入力不整合を保持し、読み込み成功後もUIから確認できるようにする。
    updateWarningCount(warningCount: number): void {
        this.warningCount_ = warningCount;
    }

    get lastID(): number {
        return this.opStore.lastID;
    }

    get lastRID(): number {
        return this.opStore.lastRID;
    }

    getOp(id: number, resolutionLevel = 0): Op | undefined {
        return this.opStore.getOp(id, resolutionLevel);
    }

    getOpForScan(id: number): Op | undefined {
        return this.opStore.getOpForScan(id);
    }

    getOpFromRID(rid: number, resolutionLevel = 0): Op | undefined {
        return this.opStore.getOpFromRID(rid, resolutionLevel);
    }

    get opCount(): number {
        return this.opStore.opCount;
    }

    retain(): ParsedTrace {
        if (this.referenceCount_ <= 0) {
            throw new Error("A closed trace cannot be retained.");
        }
        this.referenceCount_++;
        return this;
    }

    close(): void {
        if (this.referenceCount_ <= 0) {
            return;
        }
        this.referenceCount_--;
        if (this.referenceCount_ === 0) {
            this.opStore.close();
        }
    }
}

export type TraceUpdateCallback = (trace: ParsedTrace) => void;
