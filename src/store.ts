import type { Op, ParsedTrace } from "./core/model";
import {
    DEP_ARROW_TYPE,
    KonataRenderer,
    type DependencyArrowType,
    type RendererTheme,
} from "./renderer/konata_renderer";

export type LoadState = "idle" | "loading" | "ready" | "error";
export type Operation = "load" | "search";
export type DrawingThreshold =
    | "drawTextThreshold"
    | "drawDetailedlyThreshold"
    | "drawDependencyThreshold"
    | "drawFrameThreshold";

// 旧Configの初期値を維持し、新しいTabだけは直前に選んだ幅を引き継ぐ。
export const DEFAULT_SPLITTER_POSITION = 450;

export interface GlobalViewSettings {
    readonly theme: RendererTheme;
    readonly dependencyArrowType: DependencyArrowType;
    readonly splitLanes: boolean;
    readonly fixOpHeight: boolean;
    readonly drawTextThreshold: number;
    readonly drawDetailedlyThreshold: number;
    readonly drawDependencyThreshold: number;
    readonly drawFrameThreshold: number;
}

const DEFAULT_GLOBAL_VIEW_SETTINGS: GlobalViewSettings = {
    theme: "dark",
    dependencyArrowType: DEP_ARROW_TYPE.INSIDE_LINE,
    splitLanes: false,
    fixOpHeight: false,
    drawTextThreshold: 10,
    drawDetailedlyThreshold: 1,
    drawDependencyThreshold: 4,
    drawFrameThreshold: 4,
};

// 旧Configが再起動後も復元していた表示設定だけをlocalStorage境界へ公開する。
export interface PersistedViewSettings {
    readonly theme: RendererTheme;
    readonly colorScheme: string;
    readonly splitterPosition: number;
    readonly dependencyArrowType: DependencyArrowType;
    readonly drawTextThreshold: number;
    readonly drawDetailedlyThreshold: number;
    readonly drawDependencyThreshold: number;
    readonly drawFrameThreshold: number;
}

export const DEFAULT_PERSISTED_VIEW_SETTINGS: Readonly<PersistedViewSettings> = {
    theme: DEFAULT_GLOBAL_VIEW_SETTINGS.theme,
    colorScheme: "Auto",
    splitterPosition: DEFAULT_SPLITTER_POSITION,
    dependencyArrowType: DEFAULT_GLOBAL_VIEW_SETTINGS.dependencyArrowType,
    drawTextThreshold: DEFAULT_GLOBAL_VIEW_SETTINGS.drawTextThreshold,
    drawDetailedlyThreshold: DEFAULT_GLOBAL_VIEW_SETTINGS.drawDetailedlyThreshold,
    drawDependencyThreshold: DEFAULT_GLOBAL_VIEW_SETTINGS.drawDependencyThreshold,
    drawFrameThreshold: DEFAULT_GLOBAL_VIEW_SETTINGS.drawFrameThreshold,
};

export interface FindResult {
    readonly targetPattern: string;
    readonly foundString: string;
    readonly op: Op;
    readonly anchorOp: Op;
    readonly flushed: boolean;
}

export interface FindContext {
    targetPattern: string;
    requestID: number;
    progress: number | null;
    result: FindResult | null;
    message: string;
}

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
    | { readonly type: "TAB_MOVE"; readonly next: boolean }
    | { readonly type: "TAB_CLOSE"; readonly tabID: number }
    | { readonly type: "PANE_SPLITTER_MOVE"; readonly tabID: number; readonly position: number }
    | { readonly type: "KONATA_FIND_START"; readonly tabID: number; readonly targetPattern: string }
    | {
        readonly type: "KONATA_FIND_PROGRESS";
        readonly tabID: number;
        readonly requestID: number;
        readonly progress: number;
    }
    | {
        readonly type: "KONATA_FIND_FINISH";
        readonly tabID: number;
        readonly requestID: number;
        readonly result: FindResult | null;
        readonly message: string;
    }
    | { readonly type: "KONATA_FIND_HIDE_RESULT"; readonly tabID: number }
    | { readonly type: "KONATA_CHANGE_UI_COLOR_THEME"; readonly theme: RendererTheme }
    | { readonly type: "KONATA_SET_DEP_ARROW_TYPE"; readonly arrowType: DependencyArrowType }
    | { readonly type: "KONATA_SPLIT_LANES"; readonly enabled: boolean }
    | { readonly type: "KONATA_FIX_OP_HEIGHT"; readonly enabled: boolean }
    | { readonly type: "KONATA_CHANGE_COLOR_SCHEME"; readonly tabID: number; readonly scheme: string }
    | { readonly type: "KONATA_HIDE_FLUSHED_OPS"; readonly tabID: number; readonly enabled: boolean }
    | {
        readonly type: "KONATA_CHANGE_DRAWING_THRESHOLD";
        readonly threshold: DrawingThreshold;
        readonly value: number;
    }
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
    | { readonly type: "PANE_SIZE_UPDATE"; readonly tabID: number }
    | { readonly type: "VIEW_SETTINGS_UPDATE" }
    // nullは全TabのRendererへ同じ変更を適用したことを表す。
    | { readonly type: "PANE_CONTENT_UPDATE"; readonly tabID: number | null }
    | { readonly type: "WINDOW_CSS_UPDATE" }
    | { readonly type: "PROGRESS_BAR_START"; readonly tabID: number; readonly operation: Operation }
    | {
        readonly type: "PROGRESS_BAR_UPDATE";
        readonly tabID: number;
        readonly operation: Operation;
        readonly progress: number;
    }
    | { readonly type: "PROGRESS_BAR_FINISH"; readonly tabID: number; readonly operation: Operation };

// 旧Tabと同じく、1つの入力、その命令列、Renderer状態を同じ寿命で所有する。
export class Tab {
    private readonly loadAbortController_ = new AbortController();
    trace: ParsedTrace | null = null;
    loadState: LoadState = "loading";
    progress = 0;
    errorMessage = "";
    // 旧Tabと同じく、検索結果と取消IDはtraceごとに独立して保持する。
    readonly findContext: FindContext = {
        targetPattern: "",
        requestID: 0,
        progress: null,
        result: null,
        message: "",
    };

    constructor(
        readonly id: number,
        readonly fileName: string,
        readonly renderer: KonataRenderer,
        public splitterPosition = DEFAULT_SPLITTER_POSITION,
    ) {}

    get loadSignal(): AbortSignal {
        return this.loadAbortController_.signal;
    }

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
        // 入力streamとParserはこのTabだけに属するため、traceを解放する前に停止を通知する。
        this.loadAbortController_.abort();
        // Tabを参照して動作中の非同期検索を止め、Opへの参照もtraceと同時に外す。
        this.findContext.requestID++;
        this.findContext.progress = null;
        this.findContext.result = null;
        this.findContext.message = "";
        // Renderer側の参照も外し、このtabを閉じるだけでtrace全体を回収できるようにする。
        this.renderer.setTrace(null);
        trace?.close();
    }
}

export interface StoreSnapshot {
    readonly tabs: readonly Readonly<Tab>[];
    readonly activeTabID: number | null;
    readonly settings: Readonly<GlobalViewSettings>;
    readonly revision: number;
}

// 旧Storeのうち、tab状態の所有とACTION→CHANGEの一方向更新をWeb向けに復元する。
export class Store {
    private readonly tabs_ = new Map<number, Tab>();
    private readonly snapshotListeners_ = new Set<() => void>();
    private readonly changeListeners_ = new Set<(change: Change) => void>();
    private nextOpenedTabID_ = 0;
    private defaultColorScheme_: string;
    private defaultSplitterPosition_: number;
    private settings_: GlobalViewSettings;
    private snapshot_: StoreSnapshot;

    constructor(viewSettings: Readonly<PersistedViewSettings> = DEFAULT_PERSISTED_VIEW_SETTINGS) {
        this.defaultColorScheme_ = viewSettings.colorScheme;
        this.defaultSplitterPosition_ = viewSettings.splitterPosition;
        this.settings_ = {
            ...DEFAULT_GLOBAL_VIEW_SETTINGS,
            theme: viewSettings.theme,
            dependencyArrowType: viewSettings.dependencyArrowType,
            drawTextThreshold: viewSettings.drawTextThreshold,
            drawDetailedlyThreshold: viewSettings.drawDetailedlyThreshold,
            drawDependencyThreshold: viewSettings.drawDependencyThreshold,
            drawFrameThreshold: viewSettings.drawFrameThreshold,
        };
        this.snapshot_ = {
            tabs: [],
            activeTabID: null,
            settings: this.settings_,
            revision: 0,
        };
    }

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

    get persistedViewSettings(): PersistedViewSettings {
        return {
            theme: this.settings_.theme,
            colorScheme: this.defaultColorScheme_,
            splitterPosition: this.defaultSplitterPosition_,
            dependencyArrowType: this.settings_.dependencyArrowType,
            drawTextThreshold: this.settings_.drawTextThreshold,
            drawDetailedlyThreshold: this.settings_.drawDetailedlyThreshold,
            drawDependencyThreshold: this.settings_.drawDependencyThreshold,
            drawFrameThreshold: this.settings_.drawFrameThreshold,
        };
    }

    dispatch(action: Action): void {
        switch (action.type) {
        case "FILE_OPEN": {
            // 新しいTabにも、その時点の全体設定を既存Tabと同じ値で適用する。
            this.applyGlobalViewSettings_(action.renderer);
            action.renderer.changeColorScheme(this.defaultColorScheme_);
            const tab = new Tab(
                this.nextOpenedTabID_++,
                action.fileName,
                action.renderer,
                this.defaultSplitterPosition_,
            );
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
        case "TAB_MOVE": {
            const openTabs = Array.from(this.tabs_.values());
            const activeIndex = openTabs.findIndex((tab) => tab.id === this.snapshot_.activeTabID);
            if (openTabs.length < 2 || activeIndex < 0) {
                return;
            }
            // 旧TAB_MOVEと同じく並べ替えはせず、画面上のTab順で前後を循環する。
            const offset = action.next ? 1 : openTabs.length - 1;
            const nextTab = openTabs[(activeIndex + offset) % openTabs.length];
            this.dispatch({ type: "TAB_ACTIVATE", tabID: nextTab.id });
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
                { type: "PROGRESS_BAR_FINISH", tabID: action.tabID, operation: "search" },
                { type: "PANE_CONTENT_UPDATE", tabID: activeTabID },
            ]);
            return;
        }
        case "PANE_SPLITTER_MOVE": {
            const tab = this.tabs_.get(action.tabID);
            if (tab === undefined || !Number.isFinite(action.position)) {
                return;
            }
            const position = Math.max(0, action.position);
            tab.splitterPosition = position;
            this.defaultSplitterPosition_ = position;
            this.publish_(this.snapshot_.activeTabID, [
                { type: "VIEW_SETTINGS_UPDATE" },
                { type: "PANE_SIZE_UPDATE", tabID: tab.id },
                { type: "PANE_CONTENT_UPDATE", tabID: tab.id },
            ]);
            return;
        }
        case "KONATA_FIND_START": {
            const tab = this.tabs_.get(action.tabID);
            if (tab === undefined) {
                return;
            }
            const context = tab.findContext;
            context.targetPattern = action.targetPattern;
            context.requestID++;
            context.progress = 0;
            context.result = null;
            context.message = "";
            this.publish_(this.snapshot_.activeTabID, [
                { type: "PROGRESS_BAR_START", tabID: tab.id, operation: "search" },
                { type: "PANE_CONTENT_UPDATE", tabID: tab.id },
            ]);
            return;
        }
        case "KONATA_FIND_PROGRESS": {
            const tab = this.tabs_.get(action.tabID);
            if (tab === undefined || tab.findContext.requestID !== action.requestID) {
                return;
            }
            tab.findContext.progress = action.progress;
            this.publish_(this.snapshot_.activeTabID, [{
                type: "PROGRESS_BAR_UPDATE",
                tabID: tab.id,
                operation: "search",
                progress: action.progress,
            }]);
            return;
        }
        case "KONATA_FIND_FINISH": {
            const tab = this.tabs_.get(action.tabID);
            if (tab === undefined || tab.findContext.requestID !== action.requestID) {
                return;
            }
            tab.findContext.progress = null;
            tab.findContext.result = action.result;
            tab.findContext.message = action.message;
            this.publish_(this.snapshot_.activeTabID, [
                { type: "PROGRESS_BAR_FINISH", tabID: tab.id, operation: "search" },
                { type: "PANE_CONTENT_UPDATE", tabID: tab.id },
            ]);
            return;
        }
        case "KONATA_FIND_HIDE_RESULT": {
            const tab = this.tabs_.get(action.tabID);
            if (tab === undefined) {
                return;
            }
            const context = tab.findContext;
            context.requestID++;
            context.progress = null;
            context.result = null;
            context.message = "";
            this.publish_(this.snapshot_.activeTabID, [
                { type: "PROGRESS_BAR_FINISH", tabID: tab.id, operation: "search" },
                { type: "PANE_CONTENT_UPDATE", tabID: tab.id },
            ]);
            return;
        }
        case "KONATA_CHANGE_UI_COLOR_THEME": {
            this.setGlobalViewSettings_({ ...this.settings_, theme: action.theme }, true, true);
            return;
        }
        case "KONATA_SET_DEP_ARROW_TYPE": {
            this.setGlobalViewSettings_({
                ...this.settings_,
                dependencyArrowType: action.arrowType,
            }, false, true);
            return;
        }
        case "KONATA_SPLIT_LANES": {
            this.setGlobalViewSettings_({ ...this.settings_, splitLanes: action.enabled });
            return;
        }
        case "KONATA_FIX_OP_HEIGHT": {
            this.setGlobalViewSettings_({ ...this.settings_, fixOpHeight: action.enabled });
            return;
        }
        case "KONATA_CHANGE_COLOR_SCHEME": {
            const tab = this.tabs_.get(action.tabID);
            if (tab === undefined) {
                return;
            }
            // 旧Configと同様に、選択値は対象Tabだけへ適用し、新しいTabの既定値にもする。
            this.defaultColorScheme_ = action.scheme;
            tab.renderer.changeColorScheme(action.scheme);
            this.publish_(this.snapshot_.activeTabID, [
                { type: "VIEW_SETTINGS_UPDATE" },
                { type: "PANE_CONTENT_UPDATE", tabID: tab.id },
            ]);
            return;
        }
        case "KONATA_HIDE_FLUSHED_OPS": {
            const tab = this.tabs_.get(action.tabID);
            if (tab === undefined) {
                return;
            }
            const renderer = tab.renderer;
            // 表示方式を変えても、現在の先頭命令とそのfetch位置を維持する。
            const current = renderer.getOpFromPixelPositionY(0);
            const rid = current?.rid ?? 0;
            renderer.hideFlushedOps = action.enabled;
            const op = renderer.getOpFromRID(rid);
            if (op !== undefined) {
                renderer.moveLogicalPosition([op.fetchedCycle, action.enabled ? rid : op.id]);
            }
            this.publish_(this.snapshot_.activeTabID, [
                { type: "PANE_CONTENT_UPDATE", tabID: tab.id },
            ]);
            return;
        }
        case "KONATA_CHANGE_DRAWING_THRESHOLD": {
            this.setGlobalViewSettings_(
                { ...this.settings_, [action.threshold]: action.value },
                false,
                true,
            );
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
        this.snapshot_ = {
            tabs: [],
            activeTabID: null,
            settings: this.settings_,
            revision: this.snapshot_.revision + 1,
        };
        this.snapshotListeners_.clear();
        this.changeListeners_.clear();
    }

    private setGlobalViewSettings_(
        settings: GlobalViewSettings,
        windowCSS = false,
        persist = false,
    ): void {
        this.settings_ = settings;
        for (const tab of this.tabs_.values()) {
            this.applyGlobalViewSettings_(tab.renderer);
        }
        const changes: Change[] = [{ type: "PANE_CONTENT_UPDATE", tabID: null }];
        if (persist) {
            changes.unshift({ type: "VIEW_SETTINGS_UPDATE" });
        }
        if (windowCSS) {
            changes.unshift({ type: "WINDOW_CSS_UPDATE" });
        }
        this.publish_(this.snapshot_.activeTabID, changes);
    }

    private applyGlobalViewSettings_(renderer: KonataRenderer): void {
        const settings = this.settings_;
        renderer.setTheme(settings.theme);
        renderer.dependencyArrowType = settings.dependencyArrowType;
        renderer.splitLanes = settings.splitLanes;
        renderer.fixOpHeight = settings.fixOpHeight;
        renderer.drawTextThreshold = settings.drawTextThreshold;
        renderer.drawDetailedlyThreshold = settings.drawDetailedlyThreshold;
        renderer.drawDependencyThreshold = settings.drawDependencyThreshold;
        renderer.drawFrameThreshold = settings.drawFrameThreshold;
    }

    private publish_(activeTabID: number | null, changes: readonly Change[]): void {
        this.snapshot_ = {
            tabs: Array.from(this.tabs_.values()),
            activeTabID,
            settings: this.settings_,
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
