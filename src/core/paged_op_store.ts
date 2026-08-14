// 大きなtraceのOpを、旧BigKeyValueStoreと同じ多段pageで保持する。
//
// PagedOpStore
//   ├─ span 1, 8, 64, ... ごとのOpPageLevel
//   │    ├─ JSONまたはzstdへ退避したpage
//   │    └─ 最大数を制限した展開済みpage LRU
//   └─ 描画で繰り返し参照するOpのLRU
//
// setOp()はIDが各spanで割り切れるlevelへOpを書き、縮小表示時は最も粗い有効levelから
// 取得する。これにより、離れたOpを描くために細かいpageを大量展開することを避ける。
// 展開済みpageが上限を超えると、dirty pageをJSON.stringify()で保存し、必要ならpage単位の
// 独立したzstd frameへ圧縮して元のOp参照を切る。getOp()は必要なpageだけを同期的に戻すため、
// Renderer側の同期APIは旧版のまま維持できる。OpはJSONで表せるdataだけを持つため、page側で
// fieldごとの変換やclass instanceの再生成は行わない。

import { Zstd } from "@hpcc-js/wasm-zstd";

import { type Op } from "./model";
import { resolveOpID, type MutableOpStore } from "./op_store";

// 各levelが保持する命令IDの間隔。level 0は全命令を持ち、以降は8命令ごとに間引くことで、
// 縮小表示時に細かいpageを大量に展開せず、粗いlevelだけから命令を取得できるようにする。
const DEFAULT_LEVEL_SPANS = [1, 8, 64, 512, 4096] as const;
// 描画で復元したOpをpage cacheとは別に保持するLRUの上限。panやzoomで同じ命令を繰り返し
// 復元するcostを抑えつつ、大きなtraceでも未圧縮Opが増え続けない旧実装の値を維持する。
const DEFAULT_MAX_CACHED_OPS = 32768;
// pageは読込み中とcache miss時に同期圧縮するため、zstdは圧縮率より応答速度を優先するlevel 1を使う。
const ZSTD_COMPRESSION_LEVEL = 1;

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
    close(): void;
}

export interface PagedOpStoreOptions {
    pageSizeBits?: number;
    maxDecodedPages?: number;
    maxCachedOps?: number;
    levelSpans?: readonly number[];
}

export interface OpPageLevelMetrics {
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

const jsonPageCodec: PageCodec = {
    name: "json",
    encode: (serialized) => serialized,
    decode: (payload) => {
        if (typeof payload !== "string") {
            throw new Error("Expected a JSON page.");
        }
        return payload;
    },
    close: () => undefined,
};

function createZstdPageCodec(zstd: Zstd): PageCodec {
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    let encodeBuffer = new Uint8Array(0);

    const encode = (serialized: string): Uint8Array => {
        // TextEncoder.encode()はpageごとに一時Uint8Arrayを作る。Chromiumではこの確保と
        // UTF-8変換が大きなtraceの読込み時間を占めるため、最大page用のbufferを再利用する。
        // JSONは通常ASCIIが中心なので、まず1 UTF-16 code unitあたり1 byteだけを確保する。
        if (encodeBuffer.byteLength < serialized.length) {
            encodeBuffer = new Uint8Array(serialized.length);
        }

        let encoded = encoder.encodeInto(serialized, encodeBuffer);
        if (encoded.read !== serialized.length) {
            // Unicodeを含む場合は、変換済み部分の実byte数と、未読部分のUTF-8上限から拡張する。
            // surrogate pairも2 code unitsで最大4 bytesなので、3 bytes/code unitで不足しない。
            const requiredCapacity = encoded.written + (serialized.length - encoded.read) * 3;
            encodeBuffer = new Uint8Array(requiredCapacity);
            encoded = encoder.encodeInto(serialized, encodeBuffer);
        }
        if (encoded.read !== serialized.length) {
            throw new Error("The operation page could not be encoded as UTF-8.");
        }

        // compress()は同期的にWASMへ入力をコピーする。返却後は同じ作業bufferを次のpageで
        // 上書きでき、各pageが保持する圧縮済みUint8Arrayは互いに独立したままになる。
        return zstd.compress(
            encodeBuffer.subarray(0, encoded.written),
            ZSTD_COMPRESSION_LEVEL,
        );
    };

    return {
        name: "zstd",
        // pageは独立したframeにし、表示に必要なpageだけを同期的に復元できるようにする。
        encode,
        decode: (payload) => {
            if (!(payload instanceof Uint8Array)) {
                throw new Error("Expected a Zstandard page.");
            }
            return decoder.decode(zstd.decompress(payload));
        },
        close: () => {
            // close後もStoreが参照される場合に、最大page用の作業bufferだけを残さない。
            encodeBuffer = new Uint8Array(0);
        },
    };
}

// 8倍ずつ間引いたOpを独立したpage群へ保存し、縮小時の展開回数を抑える。
class OpPageLevel {
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

    get metrics(): OpPageLevelMetrics {
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
            const storedOps = JSON.parse(serialized) as Array<Op | null>;
            // Op、Lane、Stage、Dependencyはいずれもdataだけなので、旧版と同じく
            // JSON.parseの結果を変換せずに利用できる。
            ops = storedOps.map((stored) => stored ?? undefined);
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
                // Opにobject参照や保存専用fieldはないため、旧版と同じくpageを直接JSON化する。
                const serialized = JSON.stringify(page.ops);
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

// 旧BigKeyValueStoreと同じ多段pageとOp LRUを、JSONまたはzstd pageで再現する。
export class PagedOpStore implements MutableOpStore {
    private readonly levels_: readonly OpPageLevel[];
    private readonly maxCachedOps_: number;
    private readonly opCache_ = new Map<number, Op>();
    private readonly retiredOpIDs_: Array<number | undefined> = [];
    private lastID_ = -1;
    private lastRID_ = -1;
    private opCount_ = 0;
    private opCacheAccessCount_ = 0;
    private opCacheHitCount_ = 0;

    constructor(
        options: PagedOpStoreOptions = {},
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
            new OpPageLevel(span, pageSize, maxDecodedPages, pageCodec_));
        this.maxCachedOps_ = maxCachedOps;
    }

    static async createZstd(options: PagedOpStoreOptions = {}): Promise<PagedOpStore> {
        // WASMのcompileだけを非同期で済ませ、描画時の同期getOp()は維持する。
        return new PagedOpStore(options, createZstdPageCodec(await Zstd.load()));
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

    get levelMetrics(): readonly OpPageLevelMetrics[] {
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

    getOpForScan(id: number): Op | undefined {
        if (id < 0 || id > this.lastID_) {
            return undefined;
        }
        // 順次走査はlevel 0のpage LRUだけを使い、対話操作用Op LRUへ登録しない。
        return this.levels_[0].getOp(id);
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
        this.pageCodec_.close();
        this.opCache_.clear();
        this.retiredOpIDs_.length = 0;
        this.lastID_ = -1;
        this.lastRID_ = -1;
        this.opCount_ = 0;
        this.opCacheAccessCount_ = 0;
        this.opCacheHitCount_ = 0;
    }

    private levelForID_(id: number): OpPageLevel {
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
