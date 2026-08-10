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
// lastParsedStageに限ってlane名と配列内の位置へ置き換える。
type StoredStagePosition = [laneName: string, stageIndex: number] | null;
export type OpJSON = Omit<Op, "lanes" | "prods" | "cons" | "lastParsedStage" | "toJSON"> & {
    lanes: Record<string, Lane>;
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
    // 各命令が持つlaneは少数で、名前による取得・追加・列挙だけに使う。
    // 旧版と同じobjectなら命令ごとのMap割当てと保存時の変換が不要になる。
    // trace由来の"__proto__"等も通常のkeyとして扱えるようprototypeを持たせない。
    readonly lanes = Object.create(null) as Record<string, Lane>;
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
        for (const [laneName, lane] of Object.entries(this.lanes)) {
            const stageIndex = this.lastParsedStage === null
                ? -1
                : lane.stages.indexOf(this.lastParsedStage);
            if (stageIndex !== -1) {
                lastParsedStage = [laneName, stageIndex];
                break;
            }
        }
        return { ...this, lastParsedStage };
    }

    static fromJSON(stored: OpJSON): Op {
        const { lanes, prods, cons, lastParsedStage, ...fields } = stored;

        // Lane、Stage、Dependencyはmethodを持たないdataなので、JSON.parseが作ったobjectを
        // そのまま利用する。Opだけは初期値とprototypeなしのlane辞書を得るため作り直す。
        const op = Object.assign(new Op(), fields);
        Object.assign(op.lanes, lanes);
        op.prods.push(...prods);
        op.cons.push(...cons);

        if (lastParsedStage !== null) {
            const [laneName, stageIndex] = lastParsedStage;
            // 別のStageを生成せず、lanes内にある同一objectへの参照を復元する。Parserは
            // retire後に現れるtype=2のL commandも、この参照を通してStageへ追記する。
            op.lastParsedStage = op.lanes[laneName]?.stages[stageIndex] ?? null;
        }
        return op;
    }
}

export interface StageLevel {
    // 同一lane中で最初に現れた段数。
    appearance: number;
    // 同一lane中で異なるstage名ごとに割り当てる段数。
    unique: number;
}

export class StageLevelMap {
    private readonly levels_ = new Map<string, Map<string, StageLevel>>();
    private readonly laneIDs_ = new Map<string, number>();

    update(laneName: string, stageName: string, lane: Lane): void {
        let laneLevels = this.levels_.get(laneName);
        if (laneLevels === undefined) {
            laneLevels = new Map<string, StageLevel>();
            this.levels_.set(laneName, laneLevels);

            // laneが増えたため、lane名順になるようIDを振り直す。
            const laneNames = [...this.levels_.keys()].sort();
            this.laneIDs_.clear();
            laneNames.forEach((name, index) => this.laneIDs_.set(name, index));
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

    getLaneID(laneName: string): number {
        return this.laneIDs_.get(laneName) ?? 0;
    }

    get laneNum(): number {
        return this.laneIDs_.size;
    }
}

export class ParsedTrace {
    constructor(
        readonly fileName: string,
        readonly opStore: OpStore,
        readonly laneNames: ReadonlySet<string>,
        readonly stageLevelMap: StageLevelMap,
        private lastCycle_: number,
    ) {}

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
