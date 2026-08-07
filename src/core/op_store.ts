import type { Op } from "./model";

// 旧BigKeyValueStoreは縮小表示時にIDをblock先頭へ丸め、cache汚染を抑えていた。
// bit演算の32-bit制限を避け、同じ2^(level+1)単位の丸めを算術で表す。
export function resolveOpID(id: number, resolutionLevel: number): number {
    const normalizedLevel = Number.isFinite(resolutionLevel) ? Math.floor(resolutionLevel) : 0;
    const level = Math.max(0, normalizedLevel);
    if (level < 1) {
        return id;
    }
    const blockSize = 2 ** (level + 1);
    return Math.floor(id / blockSize) * blockSize;
}

// Rendererや検索処理は同期取得だけに依存させ、背後の圧縮・先読み方式を隠す。
export interface OpStore {
    readonly lastID: number;
    readonly lastRID: number;
    readonly opCount: number;

    // パースが終わって表示可能なopを返す。将来のページstoreでは複製を返してよい。
    getOp(id: number, resolutionLevel?: number): Op | undefined;
    getOpFromRID(rid: number, resolutionLevel?: number): Op | undefined;

    // 旧OpListのcloseと同じく、tabを閉じた後に内部資源を解放する。
    close(): void;
}

// Parserだけが使う書き込み契約。getOp()の結果を変更した場合は再設定する。
export interface MutableOpStore extends OpStore {
    // setOp後の値は基本的に不変とし、変更が必要ならgetOpしてから再設定する。
    setOp(id: number, op: Op): void;
    setRetiredOp(rid: number, op: Op): void;
}

// Phase 2で導入した小規模入力向けstore。圧縮せず、疎なIDを配列indexへ直接置く。
export class ArrayOpStore implements MutableOpStore {
    private readonly ops_: Array<Op | undefined> = [];
    // RIDからIDだけを引き、Op本体を二重に保持しない旧OpListの構造を維持する。
    private readonly retiredOpIDs_: Array<number | undefined> = [];
    private lastID_ = -1;
    private lastRID_ = -1;
    private opCount_ = 0;

    get lastID(): number {
        return this.lastID_;
    }

    get lastRID(): number {
        return this.lastRID_;
    }

    get opCount(): number {
        return this.opCount_;
    }

    setOp(id: number, op: Op): void {
        if (id < 0) {
            return;
        }
        if (this.ops_[id] === undefined) {
            this.opCount_++;
        }
        this.ops_[id] = op;
        this.lastID_ = Math.max(this.lastID_, id);
    }

    getOp(id: number, resolutionLevel = 0): Op | undefined {
        if (id < 0 || id > this.lastID_) {
            return undefined;
        }
        return this.ops_[resolveOpID(id, resolutionLevel)];
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
        // 配列自体はreadonlyでも内容は破棄できる。参照を保持するOpを一度に解放する。
        this.ops_.length = 0;
        this.retiredOpIDs_.length = 0;
        this.lastID_ = -1;
        this.lastRID_ = -1;
        this.opCount_ = 0;
    }
}
