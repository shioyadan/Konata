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
    // lane名から、そのlaneに現れたstage列を引く。
    readonly lanes = new Map<string, Lane>();
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
        readonly ops: Array<Op | undefined>,
        readonly retiredOps: Array<Op | undefined>,
        readonly laneNames: ReadonlySet<string>,
        readonly stageLevelMap: StageLevelMap,
        readonly lastID: number,
        readonly lastRID: number,
        readonly lastCycle: number,
    ) {}

    getOp(id: number): Op | undefined {
        return this.ops[id];
    }

    getOpFromRID(rid: number): Op | undefined {
        return this.retiredOps[rid];
    }

    get opCount(): number {
        let count = 0;
        for (const op of this.ops) {
            if (op !== undefined) {
                count++;
            }
        }
        return count;
    }
}
