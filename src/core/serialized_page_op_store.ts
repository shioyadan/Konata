import { Zstd } from "@hpcc-js/wasm-zstd";

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

type StoredPagePayload = string | Uint8Array;

interface StoredPage {
    readonly payload: StoredPagePayload;
    readonly serializedCharacters: number;
}

interface PageCodec {
    readonly name: "json" | "zstd";
    encode(serialized: string): StoredPagePayload;
    decode(payload: StoredPagePayload): string;
}

export interface SerializedPageOpStoreOptions {
    pageSizeBits?: number;
    maxDecodedPages?: number;
    maxCachedOps?: number;
    levelSpans?: readonly number[];
}

export interface SerializedPageLevelMetrics {
    readonly span: number;
    readonly serializedPages: number;
    readonly decodedPages: number;
    readonly serializedCharacters: number;
    readonly storedSize: number;
    readonly serializeCount: number;
    readonly serializeMilliseconds: number;
    readonly maxSerializeMilliseconds: number;
    readonly decodeCount: number;
    readonly decodeMilliseconds: number;
    readonly maxDecodeMilliseconds: number;
}

const RETIRED_FLAG = 1;
const FLUSH_FLAG = 2;
const EOF_FLAG = 4;
const DEFAULT_LEVEL_SPANS = [1, 8, 64, 512, 4096] as const;
const DEFAULT_MAX_CACHED_OPS = 32768;
const ZSTD_COMPRESSION_LEVEL = 1;

const jsonPageCodec: PageCodec = {
    name: "json",
    encode: (serialized) => serialized,
    decode: (payload) => {
        if (typeof payload !== "string") {
            throw new Error("Expected a JSON page.");
        }
        return payload;
    },
};

function createZstdPageCodec(zstd: Zstd): PageCodec {
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    return {
        name: "zstd",
        // pageは独立したframeにし、表示に必要なpageだけを同期的に復元できるようにする。
        encode: (serialized) => zstd.compress(encoder.encode(serialized), ZSTD_COMPRESSION_LEVEL),
        decode: (payload) => {
            if (!(payload instanceof Uint8Array)) {
                throw new Error("Expected a Zstandard page.");
            }
            return decoder.decode(zstd.decompress(payload));
        },
    };
}

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

// 8倍ずつ間引いたOpを独立したpage群へ保存し、縮小時の展開回数を抑える。
class SerializedPageLevel {
    private readonly serializedPages_ = new Map<number, StoredPage>();
    private readonly decodedPages_ = new Map<number, DecodedPage>();
    private readonly decodedPageLRU_ = new Map<number, true>();
    private serializeCount_ = 0;
    private serializeMilliseconds_ = 0;
    private maxSerializeMilliseconds_ = 0;
    private decodeCount_ = 0;
    private decodeMilliseconds_ = 0;
    private maxDecodeMilliseconds_ = 0;

    constructor(
        readonly span: number,
        private readonly pageSize_: number,
        private readonly maxDecodedPages_: number,
        private readonly codec_: PageCodec,
    ) {}

    get metrics(): SerializedPageLevelMetrics {
        let serializedCharacters = 0;
        let storedSize = 0;
        for (const stored of this.serializedPages_.values()) {
            serializedCharacters += stored.serializedCharacters;
            storedSize += typeof stored.payload === "string"
                ? stored.payload.length
                : stored.payload.byteLength;
        }
        return {
            span: this.span,
            serializedPages: this.serializedPages_.size,
            decodedPages: this.decodedPages_.size,
            serializedCharacters,
            storedSize,
            serializeCount: this.serializeCount_,
            serializeMilliseconds: this.serializeMilliseconds_,
            maxSerializeMilliseconds: this.maxSerializeMilliseconds_,
            decodeCount: this.decodeCount_,
            decodeMilliseconds: this.decodeMilliseconds_,
            maxDecodeMilliseconds: this.maxDecodeMilliseconds_,
        };
    }

    setOp(blockID: number, op: Op): boolean {
        const pageIndex = this.pageIndex_(blockID);
        const page = this.loadPage_(pageIndex);
        const offset = blockID - pageIndex * this.pageSize_;
        const added = page.ops[offset] === undefined;
        page.ops[offset] = op;
        page.dirty = true;
        return added;
    }

    getOp(blockID: number): Op | undefined {
        const pageIndex = this.pageIndex_(blockID);
        const page = this.loadPage_(pageIndex);
        return page.ops[blockID - pageIndex * this.pageSize_];
    }

    close(): void {
        this.serializedPages_.clear();
        this.decodedPages_.clear();
        this.decodedPageLRU_.clear();
        this.serializeCount_ = 0;
        this.serializeMilliseconds_ = 0;
        this.maxSerializeMilliseconds_ = 0;
        this.decodeCount_ = 0;
        this.decodeMilliseconds_ = 0;
        this.maxDecodeMilliseconds_ = 0;
    }

    private pageIndex_(blockID: number): number {
        return Math.floor(blockID / this.pageSize_);
    }

    private loadPage_(pageIndex: number): DecodedPage {
        const cached = this.decodedPages_.get(pageIndex);
        if (cached !== undefined) {
            this.touchPage_(pageIndex);
            return cached;
        }

        const storedPage = this.serializedPages_.get(pageIndex);
        let ops: Array<Op | undefined> = [];
        if (storedPage !== undefined) {
            const start = performance.now();
            const serialized = this.codec_.decode(storedPage.payload);
            const storedOps = JSON.parse(serialized) as Array<StoredOp | null>;
            ops = storedOps.map((stored) => stored === null ? undefined : deserializeOp(stored));
            const milliseconds = performance.now() - start;
            this.decodeCount_++;
            this.decodeMilliseconds_ += milliseconds;
            this.maxDecodeMilliseconds_ = Math.max(this.maxDecodeMilliseconds_, milliseconds);
        }
        const page: DecodedPage = { ops, dirty: false };
        this.decodedPages_.set(pageIndex, page);
        this.touchPage_(pageIndex);
        this.evictPages_();
        return page;
    }

    private touchPage_(pageIndex: number): void {
        // Mapの挿入順をLRU順とし、参照したpageを末尾へ入れ直す。
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
                const start = performance.now();
                const storedOps = page.ops.map((op) => op === undefined ? null : serializeOp(op));
                const serialized = JSON.stringify(storedOps);
                this.serializedPages_.set(oldest, {
                    payload: this.codec_.encode(serialized),
                    serializedCharacters: serialized.length,
                });
                const milliseconds = performance.now() - start;
                this.serializeCount_++;
                this.serializeMilliseconds_ += milliseconds;
                this.maxSerializeMilliseconds_ = Math.max(this.maxSerializeMilliseconds_, milliseconds);
            }
            this.decodedPages_.delete(oldest);
        }
    }
}

// 旧BigKeyValueStoreと同じ多段pageとOp LRUを、JSONまたはzstd pageで再現する試作。
export class SerializedPageOpStore implements MutableOpStore {
    private readonly levels_: readonly SerializedPageLevel[];
    private readonly maxCachedOps_: number;
    private readonly opCache_ = new Map<number, Op>();
    private readonly retiredOpIDs_: Array<number | undefined> = [];
    private lastID_ = -1;
    private lastRID_ = -1;
    private opCount_ = 0;
    private opCacheAccessCount_ = 0;
    private opCacheHitCount_ = 0;

    constructor(
        options: SerializedPageOpStoreOptions = {},
        private readonly pageCodec_: PageCodec = jsonPageCodec,
    ) {
        const pageSizeBits = options.pageSizeBits ?? 8;
        const maxDecodedPages = options.maxDecodedPages ?? 4;
        const maxCachedOps = options.maxCachedOps ?? DEFAULT_MAX_CACHED_OPS;
        const levelSpans = options.levelSpans ?? DEFAULT_LEVEL_SPANS;
        if (!Number.isInteger(pageSizeBits) || pageSizeBits < 0 || pageSizeBits > 30) {
            throw new Error("pageSizeBits must be an integer between 0 and 30.");
        }
        if (!Number.isSafeInteger(maxDecodedPages) || maxDecodedPages < 1) {
            throw new Error("maxDecodedPages must be a positive safe integer.");
        }
        if (!Number.isSafeInteger(maxCachedOps) || maxCachedOps < 1) {
            throw new Error("maxCachedOps must be a positive safe integer.");
        }
        if (levelSpans.length === 0 || levelSpans[0] !== 1 || levelSpans.some((span, index) =>
            !Number.isSafeInteger(span) || span < 1 ||
            (index > 0 &&
                (span <= levelSpans[index - 1] || span % levelSpans[index - 1] !== 0)))) {
            throw new Error("levelSpans must start at 1 and contain ascending integer multiples.");
        }
        const pageSize = 2 ** pageSizeBits;
        this.levels_ = levelSpans.map((span) =>
            new SerializedPageLevel(span, pageSize, maxDecodedPages, pageCodec_));
        this.maxCachedOps_ = maxCachedOps;
    }

    static async createZstd(options: SerializedPageOpStoreOptions = {}): Promise<SerializedPageOpStore> {
        // WASMのcompileだけを非同期で済ませ、描画時の同期getOp()は維持する。
        return new SerializedPageOpStore(options, createZstdPageCodec(await Zstd.load()));
    }

    get pageCodec(): "json" | "zstd" {
        return this.pageCodec_.name;
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
        return this.levelMetrics.reduce((sum, level) => sum + level.serializedPages, 0);
    }

    get decodedPageCount(): number {
        return this.levelMetrics.reduce((sum, level) => sum + level.decodedPages, 0);
    }

    get serializedCharacterCount(): number {
        return this.levelMetrics.reduce((sum, level) => sum + level.serializedCharacters, 0);
    }

    get storedSize(): number {
        return this.levelMetrics.reduce((sum, level) => sum + level.storedSize, 0);
    }

    get levelMetrics(): readonly SerializedPageLevelMetrics[] {
        return this.levels_.map((level) => level.metrics);
    }

    get opCacheAccessCount(): number {
        return this.opCacheAccessCount_;
    }

    get opCacheHitCount(): number {
        return this.opCacheHitCount_;
    }

    setOp(id: number, op: Op): void {
        if (id < 0) {
            return;
        }
        this.opCache_.delete(id);
        if (this.levels_[0].setOp(id, op)) {
            this.opCount_++;
        }
        for (let index = 1; index < this.levels_.length; index++) {
            const level = this.levels_[index];
            if (id % level.span === 0) {
                level.setOp(id / level.span, op);
            }
        }
        this.lastID_ = Math.max(this.lastID_, id);
    }

    getOp(id: number, resolutionLevel = 0): Op | undefined {
        if (id < 0 || id > this.lastID_) {
            return undefined;
        }
        const resolvedID = resolveOpID(id, resolutionLevel);
        this.opCacheAccessCount_++;
        const cached = this.opCache_.get(resolvedID);
        if (cached !== undefined) {
            this.opCacheHitCount_++;
            this.touchCachedOp_(resolvedID, cached);
            return cached;
        }

        const level = this.levelForID_(resolvedID);
        const op = level.getOp(resolvedID / level.span);
        if (op !== undefined) {
            this.touchCachedOp_(resolvedID, op);
        }
        return op;
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
        for (const level of this.levels_) {
            level.close();
        }
        this.opCache_.clear();
        this.retiredOpIDs_.length = 0;
        this.lastID_ = -1;
        this.lastRID_ = -1;
        this.opCount_ = 0;
        this.opCacheAccessCount_ = 0;
        this.opCacheHitCount_ = 0;
    }

    private levelForID_(id: number): SerializedPageLevel {
        for (let index = this.levels_.length - 1; index >= 0; index--) {
            if (id % this.levels_[index].span === 0) {
                return this.levels_[index];
            }
        }
        return this.levels_[0];
    }

    private touchCachedOp_(id: number, op: Op): void {
        this.opCache_.delete(id);
        this.opCache_.set(id, op);
        if (this.opCache_.size > this.maxCachedOps_) {
            const oldest = this.opCache_.keys().next().value as number | undefined;
            if (oldest !== undefined) {
                this.opCache_.delete(oldest);
            }
        }
    }
}
