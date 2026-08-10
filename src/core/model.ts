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

// Opは基本的にそのままJSONへ保存する。JSONではobject同士の参照だけを表現できないため、
// lastParsedStageに限ってlane IDと配列内の位置へ置き換える。
type StoredStagePosition = [laneID: number, stageIndex: number] | null;
export type OpJSON = Omit<Op, "lanes" | "prods" | "cons" | "lastParsedStage" | "toJSON"> & {
    lanes: Array<Lane | null>;
    prods: Dependency[];
    cons: Dependency[];
    lastParsedStage: StoredStagePosition;
};

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
    // type=2のLコマンドを直前のstageへ結び付けるために保持する。
    lastParsedStage: Stage | null = null;
    // gem5 Parserが命令ごとの最終tickを追跡するための値も、共通モデルに維持する。
    lastParsedCycle = -1;
    // producer/consumer双方から依存関係を引けるよう、両向きの索引を持つ。
    readonly prods: Dependency[] = [];
    readonly cons: Dependency[] = [];
    // 依存線を実行stageの始点と終点へ描くために使用する。
    prodCycle = -1;
    consCycle = -1;

    toJSON(): OpJSON {
        // JSON.stringifyがこのmethodを自動的に呼ぶ。通常のfieldは列挙して変換せず、
        // Opへfieldを追加した場合にもobject spreadでそのまま保存されるようにする。
        let lastParsedStage: StoredStagePosition = null;
        for (let laneID = 0; laneID < this.lanes.length; laneID++) {
            const lane = this.lanes[laneID];
            if (lane === null) {
                continue;
            }
            const stageIndex = this.lastParsedStage === null
                ? -1
                : lane.stages.indexOf(this.lastParsedStage);
            if (stageIndex !== -1) {
                lastParsedStage = [laneID, stageIndex];
                break;
            }
        }
        return { ...this, lastParsedStage };
    }

    static fromJSON(stored: OpJSON): Op {
        const { lanes, prods, cons, lastParsedStage, ...fields } = stored;

        // Lane、Stage、Dependencyはmethodを持たないdataなので、JSON.parseが作ったobjectを
        // そのまま利用する。Opだけはclassの既定値を得るため作り直す。
        const op = Object.assign(new Op(), fields);
        op.lanes.push(...lanes);
        op.prods.push(...prods);
        op.cons.push(...cons);

        if (lastParsedStage !== null) {
            const [laneID, stageIndex] = lastParsedStage;
            // 別のStageを生成せず、lanes内にある同一objectへの参照を復元する。Parserは
            // retire後に現れるtype=2のL commandも、この参照を通してStageへ追記する。
            op.lastParsedStage = op.lanes[laneID]?.stages[stageIndex] ?? null;
        }
        return op;
    }
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

    close(): void {
        this.opStore.close();
    }
}

export type TraceUpdateCallback = (trace: ParsedTrace) => void;
