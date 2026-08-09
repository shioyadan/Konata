import type { ParsedTrace } from "./core/model";
import { KonataRenderer } from "./renderer/konata_renderer";

export type LoadState = "idle" | "loading" | "ready" | "error";

export type Action =
    | { readonly type: "FILE_OPEN"; readonly fileName: string; readonly renderer: KonataRenderer }
    | { readonly type: "FILE_LOAD_PROGRESS"; readonly tabID: number; readonly progress: number }
    | { readonly type: "FILE_LOAD_TRACE"; readonly tabID: number; readonly trace: ParsedTrace }
    | { readonly type: "FILE_LOAD_FINISH"; readonly tabID: number; readonly trace: ParsedTrace }
    | {
        readonly type: "FILE_LOAD_ERROR";
        readonly tabID: number;
        readonly message: string;
        readonly trace: ParsedTrace | null;
    }
    | { readonly type: "TAB_ACTIVATE"; readonly tabID: number }
    | { readonly type: "TAB_CLOSE"; readonly tabID: number }
    // 現行UIのRenderer操作をそのまま保つための移行用action。同期scrollを戻す段階で必要な操作だけ具体化する。
    | {
        readonly type: "KONATA_MUTATE_VIEW";
        readonly tabID: number;
        readonly mutation: (renderer: KonataRenderer) => void;
    };

export type Change =
    | { readonly type: "TAB_OPEN"; readonly tabID: number }
    | { readonly type: "TAB_UPDATE"; readonly tabID: number | null }
    | { readonly type: "TAB_CLOSE"; readonly tabID: number }
    | { readonly type: "PANE_CONTENT_UPDATE"; readonly tabID: number | null }
    | { readonly type: "PROGRESS_BAR_START"; readonly tabID: number; readonly operation: "load" }
    | {
        readonly type: "PROGRESS_BAR_UPDATE";
        readonly tabID: number;
        readonly operation: "load";
        readonly progress: number;
    }
    | { readonly type: "PROGRESS_BAR_FINISH"; readonly tabID: number; readonly operation: "load" };

// 旧Tabと同じく、1つの入力、その命令列、Renderer状態を同じ寿命で所有する。
export class Tab {
    trace: ParsedTrace | null = null;
    loadState: LoadState = "loading";
    progress = 0;
    errorMessage = "";

    constructor(
        readonly id: number,
        readonly fileName: string,
        readonly renderer: KonataRenderer,
    ) {}

    setTrace(trace: ParsedTrace): void {
        if (this.trace === trace) {
            return;
        }
        const previousTrace = this.trace;
        this.trace = trace;
        this.renderer.setTrace(trace);
        previousTrace?.close();
    }

    close(): void {
        const trace = this.trace;
        this.trace = null;
        // Renderer側の参照も外し、このtabを閉じるだけでtrace全体を回収できるようにする。
        this.renderer.setTrace(null);
        trace?.close();
    }
}

export interface StoreSnapshot {
    readonly tabs: readonly Readonly<Tab>[];
    readonly activeTabID: number | null;
    readonly revision: number;
}

// 旧Storeのうち、tab状態の所有とACTION→CHANGEの一方向更新をWeb向けに復元する。
export class Store {
    private readonly tabs_ = new Map<number, Tab>();
    private readonly snapshotListeners_ = new Set<() => void>();
    private readonly changeListeners_ = new Set<(change: Change) => void>();
    private nextOpenedTabID_ = 0;
    private snapshot_: StoreSnapshot = { tabs: [], activeTabID: null, revision: 0 };

    // 同じsnapshotを変更通知まで返すことで、ReactのuseSyncExternalStoreから安全に購読できる。
    readonly subscribe = (listener: () => void): (() => void) => {
        this.snapshotListeners_.add(listener);
        return () => {
            this.snapshotListeners_.delete(listener);
        };
    };

    readonly getSnapshot = (): StoreSnapshot => this.snapshot_;

    subscribeChange(listener: (change: Change) => void): () => void {
        this.changeListeners_.add(listener);
        return () => {
            this.changeListeners_.delete(listener);
        };
    }

    get activeTab(): Tab | null {
        const id = this.snapshot_.activeTabID;
        return id === null ? null : this.tabs_.get(id) ?? null;
    }

    dispatch(action: Action): void {
        switch (action.type) {
        case "FILE_OPEN": {
            const tab = new Tab(this.nextOpenedTabID_++, action.fileName, action.renderer);
            this.tabs_.set(tab.id, tab);
            this.publish_(tab.id, [
                { type: "TAB_OPEN", tabID: tab.id },
                { type: "TAB_UPDATE", tabID: tab.id },
                { type: "PROGRESS_BAR_START", tabID: tab.id, operation: "load" },
                { type: "PANE_CONTENT_UPDATE", tabID: tab.id },
            ]);
            return;
        }
        case "FILE_LOAD_PROGRESS": {
            const tab = this.tabs_.get(action.tabID);
            if (tab === undefined) {
                return;
            }
            tab.progress = action.progress;
            this.publish_(this.snapshot_.activeTabID, [{
                type: "PROGRESS_BAR_UPDATE",
                tabID: tab.id,
                operation: "load",
                progress: action.progress,
            }]);
            return;
        }
        case "FILE_LOAD_TRACE": {
            const tab = this.tabs_.get(action.tabID);
            if (tab === undefined) {
                action.trace.close();
                return;
            }
            tab.setTrace(action.trace);
            this.publish_(this.snapshot_.activeTabID, [
                { type: "PANE_CONTENT_UPDATE", tabID: tab.id },
            ]);
            return;
        }
        case "FILE_LOAD_FINISH": {
            const tab = this.tabs_.get(action.tabID);
            if (tab === undefined) {
                action.trace.close();
                return;
            }
            tab.setTrace(action.trace);
            tab.progress = 1;
            tab.loadState = "ready";
            this.publish_(this.snapshot_.activeTabID, [
                { type: "PROGRESS_BAR_FINISH", tabID: tab.id, operation: "load" },
                { type: "PANE_CONTENT_UPDATE", tabID: tab.id },
            ]);
            return;
        }
        case "FILE_LOAD_ERROR": {
            const tab = this.tabs_.get(action.tabID);
            if (tab === undefined) {
                action.trace?.close();
                return;
            }
            const tabTrace = tab.trace;
            tab.close();
            if (action.trace !== tabTrace) {
                action.trace?.close();
            }
            tab.loadState = "error";
            tab.errorMessage = action.message;
            this.publish_(this.snapshot_.activeTabID, [
                { type: "PROGRESS_BAR_FINISH", tabID: tab.id, operation: "load" },
                { type: "PANE_CONTENT_UPDATE", tabID: tab.id },
            ]);
            return;
        }
        case "TAB_ACTIVATE": {
            if (!this.tabs_.has(action.tabID) || this.snapshot_.activeTabID === action.tabID) {
                return;
            }
            this.publish_(action.tabID, [
                { type: "TAB_UPDATE", tabID: action.tabID },
                { type: "PANE_CONTENT_UPDATE", tabID: action.tabID },
            ]);
            return;
        }
        case "TAB_CLOSE": {
            const openTabs = Array.from(this.tabs_.values());
            const closingIndex = openTabs.findIndex((tab) => tab.id === action.tabID);
            const closingTab = openTabs[closingIndex];
            if (closingTab === undefined) {
                return;
            }

            // 遅れて到着したParser結果を拒否できるよう、解放前に有効tab一覧から外す。
            this.tabs_.delete(action.tabID);
            closingTab.close();
            let activeTabID = this.snapshot_.activeTabID;
            if (activeTabID === action.tabID) {
                const remainingTabs = Array.from(this.tabs_.values());
                activeTabID = remainingTabs[Math.min(closingIndex, remainingTabs.length - 1)]?.id ?? null;
            }
            this.publish_(activeTabID, [
                { type: "TAB_CLOSE", tabID: action.tabID },
                { type: "TAB_UPDATE", tabID: activeTabID },
                { type: "PROGRESS_BAR_FINISH", tabID: action.tabID, operation: "load" },
                { type: "PANE_CONTENT_UPDATE", tabID: activeTabID },
            ]);
            return;
        }
        case "KONATA_MUTATE_VIEW": {
            const tab = this.tabs_.get(action.tabID);
            if (tab === undefined) {
                return;
            }
            action.mutation(tab.renderer);
            this.publish_(this.snapshot_.activeTabID, [
                { type: "PANE_CONTENT_UPDATE", tabID: tab.id },
            ]);
            return;
        }
        }
    }

    close(): void {
        for (const tab of this.tabs_.values()) {
            tab.close();
        }
        this.tabs_.clear();
        this.snapshot_ = { tabs: [], activeTabID: null, revision: this.snapshot_.revision + 1 };
        this.snapshotListeners_.clear();
        this.changeListeners_.clear();
    }

    private publish_(activeTabID: number | null, changes: readonly Change[]): void {
        this.snapshot_ = {
            tabs: Array.from(this.tabs_.values()),
            activeTabID,
            revision: this.snapshot_.revision + 1,
        };
        for (const listener of this.snapshotListeners_) {
            listener();
        }
        for (const change of changes) {
            for (const listener of this.changeListeners_) {
                listener(change);
            }
        }
    }
}
