import { Dependency, Lane, Op, Stage } from "./model";
import { resolveOpID, type MutableOpStore } from "./op_store";

type StoredStage = [name: string, labels: string, startCycle: number, endCycle: number];
type StoredLane = [name: string, level: number, stages: StoredStage[]];
type StoredDependency = [opID: number, type: number, cycle: number];
type StoredStagePosition = [laneIndex: number, stageIndex: number] | null;

// page内で命令ごとに繰り返すproperty名を短くし、JSON文字列側の固定overheadを抑える。
// このinterfaceを省略名とOp fieldの対応表として扱い、変換は直下の2関数へ集約する。
interface StoredOp {
    i: number;
    g: number;
    r: number;
    t: number;
    b: number;
    fc: number;
    rc: number;
    ln: number;
    n: string;
    d: string;
    lc: number;
    pc: number;
    cc: number;
    la: StoredLane[];
    p: StoredDependency[];
    c: StoredDependency[];
    ls: StoredStagePosition;
}

interface DecodedPage {
    readonly ops: Array<Op | undefined>;
    dirty: boolean;
}

export interface SerializedPageOpStoreOptions {
    pageSizeBits?: number;
    maxDecodedPages?: number;
}

const RETIRED_FLAG = 1;
const FLUSH_FLAG = 2;
const EOF_FLAG = 4;

function serializeOp(op: Op): StoredOp {
    const lanes: StoredLane[] = [];
    let lastStage: StoredStagePosition = null;

    for (const [laneName, lane] of op.lanes) {
        const laneIndex = lanes.length;
        const stages: StoredStage[] = [];
        for (const stage of lane.stages) {
            const stageIndex = stages.length;
            stages.push([stage.name, stage.labels, stage.startCycle, stage.endCycle]);
            if (stage === op.lastParsedStage) {
                // type=2のLがretire後に現れても、同じStageへ追記できるよう位置を保存する。
                lastStage = [laneIndex, stageIndex];
            }
        }
        lanes.push([laneName, lane.level, stages]);
    }

    const flags =
        (op.retired ? RETIRED_FLAG : 0) |
        (op.flush ? FLUSH_FLAG : 0) |
        (op.eof ? EOF_FLAG : 0);
    return {
        i: op.id,
        g: op.gid,
        r: op.rid,
        t: op.tid,
        b: flags,
        fc: op.fetchedCycle,
        rc: op.retiredCycle,
        ln: op.line,
        n: op.labelName,
        d: op.labelDetail,
        lc: op.lastParsedCycle,
        pc: op.prodCycle,
        cc: op.consCycle,
        la: lanes,
        p: op.prods.map((dependency) => [dependency.opID, dependency.type, dependency.cycle]),
        c: op.cons.map((dependency) => [dependency.opID, dependency.type, dependency.cycle]),
        ls: lastStage,
    };
}

function deserializeOp(stored: StoredOp): Op {
    const op = new Op();
    op.id = stored.i;
    op.gid = stored.g;
    op.rid = stored.r;
    op.tid = stored.t;
    op.retired = (stored.b & RETIRED_FLAG) !== 0;
    op.flush = (stored.b & FLUSH_FLAG) !== 0;
    op.eof = (stored.b & EOF_FLAG) !== 0;
    op.fetchedCycle = stored.fc;
    op.retiredCycle = stored.rc;
    op.line = stored.ln;
    op.labelName = stored.n;
    op.labelDetail = stored.d;
    op.lastParsedCycle = stored.lc;
    op.prodCycle = stored.pc;
    op.consCycle = stored.cc;

    const decodedLanes: Lane[] = [];
    for (const [laneName, level, storedStages] of stored.la) {
        const lane = new Lane();
        lane.level = level;
        for (const [name, labels, startCycle, endCycle] of storedStages) {
            const stage = new Stage();
            stage.name = name;
            stage.labels = labels;
            stage.startCycle = startCycle;
            stage.endCycle = endCycle;
            lane.stages.push(stage);
        }
        op.lanes.set(laneName, lane);
        decodedLanes.push(lane);
    }
    if (stored.ls !== null) {
        const [laneIndex, stageIndex] = stored.ls;
        op.lastParsedStage = decodedLanes[laneIndex]?.stages[stageIndex] ?? null;
    }

    for (const [opID, type, cycle] of stored.p) {
        op.prods.push(new Dependency(opID, type, cycle));
    }
    for (const [opID, type, cycle] of stored.c) {
        op.cons.push(new Dependency(opID, type, cycle));
    }
    return op;
}

// 完了Opを非圧縮JSON pageへ退避し、少数の展開済みpageだけを同期参照用に残す試作。
export class SerializedPageOpStore implements MutableOpStore {
    private readonly pageSize_: number;
    private readonly maxDecodedPages_: number;
    private readonly serializedPages_ = new Map<number, string>();
    private readonly decodedPages_ = new Map<number, DecodedPage>();
    // Mapの挿入順をLRU順として使い、参照時には末尾へ入れ直す。
    private readonly decodedPageLRU_ = new Map<number, true>();
    private readonly retiredOpIDs_: Array<number | undefined> = [];
    private lastID_ = -1;
    private lastRID_ = -1;
    private opCount_ = 0;

    constructor(options: SerializedPageOpStoreOptions = {}) {
        const pageSizeBits = options.pageSizeBits ?? 8;
        const maxDecodedPages = options.maxDecodedPages ?? 4;
        if (!Number.isInteger(pageSizeBits) || pageSizeBits < 0 || pageSizeBits > 30) {
            throw new Error("pageSizeBits must be an integer between 0 and 30.");
        }
        if (!Number.isSafeInteger(maxDecodedPages) || maxDecodedPages < 1) {
            throw new Error("maxDecodedPages must be a positive safe integer.");
        }
        this.pageSize_ = 2 ** pageSizeBits;
        this.maxDecodedPages_ = maxDecodedPages;
    }

    get lastID(): number {
        return this.lastID_;
    }

    get lastRID(): number {
        return this.lastRID_;
    }

    get opCount(): number {
        return this.opCount_;
    }

    get serializedPageCount(): number {
        return this.serializedPages_.size;
    }

    get decodedPageCount(): number {
        return this.decodedPages_.size;
    }

    get serializedCharacterCount(): number {
        let count = 0;
        for (const serialized of this.serializedPages_.values()) {
            count += serialized.length;
        }
        return count;
    }

    setOp(id: number, op: Op): void {
        if (id < 0) {
            return;
        }
        const pageIndex = this.pageIndex_(id);
        const page = this.loadPage_(pageIndex);
        const offset = id - pageIndex * this.pageSize_;
        if (page.ops[offset] === undefined) {
            this.opCount_++;
        }
        page.ops[offset] = op;
        page.dirty = true;
        this.lastID_ = Math.max(this.lastID_, id);
    }

    getOp(id: number, resolutionLevel = 0): Op | undefined {
        if (id < 0 || id > this.lastID_) {
            return undefined;
        }
        const resolvedID = resolveOpID(id, resolutionLevel);
        const pageIndex = this.pageIndex_(resolvedID);
        const page = this.loadPage_(pageIndex);
        return page.ops[resolvedID - pageIndex * this.pageSize_];
    }

    setRetiredOp(rid: number, op: Op): void {
        if (rid < 0) {
            return;
        }
        this.retiredOpIDs_[rid] = op.id;
        this.lastRID_ = Math.max(this.lastRID_, rid);
    }

    getOpFromRID(rid: number, resolutionLevel = 0): Op | undefined {
        if (rid < 0 || rid > this.lastRID_) {
            return undefined;
        }
        const id = this.retiredOpIDs_[rid];
        return id === undefined ? undefined : this.getOp(id, resolutionLevel);
    }

    close(): void {
        this.serializedPages_.clear();
        this.decodedPages_.clear();
        this.decodedPageLRU_.clear();
        this.retiredOpIDs_.length = 0;
        this.lastID_ = -1;
        this.lastRID_ = -1;
        this.opCount_ = 0;
    }

    private pageIndex_(id: number): number {
        return Math.floor(id / this.pageSize_);
    }

    private loadPage_(pageIndex: number): DecodedPage {
        const cached = this.decodedPages_.get(pageIndex);
        if (cached !== undefined) {
            this.touchPage_(pageIndex);
            return cached;
        }

        const serialized = this.serializedPages_.get(pageIndex);
        let ops: Array<Op | undefined> = [];
        if (serialized !== undefined) {
            const storedOps = JSON.parse(serialized) as Array<StoredOp | null>;
            ops = storedOps.map((stored) => stored === null ? undefined : deserializeOp(stored));
        }
        const page: DecodedPage = { ops, dirty: false };
        this.decodedPages_.set(pageIndex, page);
        this.touchPage_(pageIndex);
        this.evictPages_();
        return page;
    }

    private touchPage_(pageIndex: number): void {
        this.decodedPageLRU_.delete(pageIndex);
        this.decodedPageLRU_.set(pageIndex, true);
    }

    private evictPages_(): void {
        while (this.decodedPageLRU_.size > this.maxDecodedPages_) {
            const oldest = this.decodedPageLRU_.keys().next().value as number | undefined;
            if (oldest === undefined) {
                return;
            }
            this.decodedPageLRU_.delete(oldest);
            const page = this.decodedPages_.get(oldest);
            if (page === undefined) {
                continue;
            }
            if (page.dirty || !this.serializedPages_.has(oldest)) {
                // undefinedの穴はJSONでnullになり、page内offsetを維持できる。
                const storedOps = page.ops.map((op) => op === undefined ? null : serializeOp(op));
                this.serializedPages_.set(oldest, JSON.stringify(storedOps));
            }
            this.decodedPages_.delete(oldest);
        }
    }
}
