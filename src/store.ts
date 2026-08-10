import type { Op, ParsedTrace } from "./core/model";
import {
    DEFAULT_CUSTOM_COLOR_SCHEME,
    DEP_ARROW_TYPE,
    KonataRenderer,
    type CustomColorScheme,
    type DependencyArrowType,
    type RendererTheme,
} from "./renderer/konata_renderer";

export type LoadState = "idle" | "loading" | "ready" | "error";
export type Operation = "load" | "search";
export type ComparisonMode = "baseline" | "overlay" | "candidate" | "difference";
export type MinimumLaneHeightKey =
    | "textLabelMinimumLaneHeight"
    | "stageDetailMinimumLaneHeight"
    | "dependencyArrowMinimumLaneHeight"
    | "stageBorderMinimumLaneHeight";

// 旧Configの初期値を維持し、新しいTabだけは直前に選んだ幅を引き継ぐ。
export const DEFAULT_SPLITTER_POSITION = 450;

export interface GlobalViewSettings {
    readonly theme: RendererTheme;
    readonly customColorScheme: Readonly<CustomColorScheme>;
    readonly dependencyArrowType: DependencyArrowType;
    readonly splitLanes: boolean;
    readonly fixOpHeight: boolean;
    readonly textLabelMinimumLaneHeight: number;
    readonly stageDetailMinimumLaneHeight: number;
    readonly dependencyArrowMinimumLaneHeight: number;
    readonly stageBorderMinimumLaneHeight: number;
    readonly drawZoomFactor: number;
}

const DEFAULT_GLOBAL_VIEW_SETTINGS: GlobalViewSettings = {
    theme: "dark",
    customColorScheme: DEFAULT_CUSTOM_COLOR_SCHEME,
    dependencyArrowType: DEP_ARROW_TYPE.INSIDE_LINE,
    splitLanes: false,
    fixOpHeight: false,
    textLabelMinimumLaneHeight: 10,
    stageDetailMinimumLaneHeight: 1,
    dependencyArrowMinimumLaneHeight: 4,
    stageBorderMinimumLaneHeight: 4,
    drawZoomFactor: 1,
};

// 旧Configが再起動後も復元していた表示設定だけをlocalStorage境界へ公開する。
export interface PersistedViewSettings {
    readonly theme: RendererTheme;
    readonly colorScheme: string;
    readonly customColorScheme: Readonly<CustomColorScheme>;
    readonly splitterPosition: number;
    readonly dependencyArrowType: DependencyArrowType;
    readonly textLabelMinimumLaneHeight: number;
    readonly stageDetailMinimumLaneHeight: number;
    readonly dependencyArrowMinimumLaneHeight: number;
    readonly stageBorderMinimumLaneHeight: number;
    readonly drawZoomFactor: number;
}

export const DEFAULT_PERSISTED_VIEW_SETTINGS: Readonly<PersistedViewSettings> = {
    theme: DEFAULT_GLOBAL_VIEW_SETTINGS.theme,
    colorScheme: "Auto",
    customColorScheme: DEFAULT_GLOBAL_VIEW_SETTINGS.customColorScheme,
    splitterPosition: DEFAULT_SPLITTER_POSITION,
    dependencyArrowType: DEFAULT_GLOBAL_VIEW_SETTINGS.dependencyArrowType,
    textLabelMinimumLaneHeight: DEFAULT_GLOBAL_VIEW_SETTINGS.textLabelMinimumLaneHeight,
    stageDetailMinimumLaneHeight: DEFAULT_GLOBAL_VIEW_SETTINGS.stageDetailMinimumLaneHeight,
    dependencyArrowMinimumLaneHeight: DEFAULT_GLOBAL_VIEW_SETTINGS.dependencyArrowMinimumLaneHeight,
    stageBorderMinimumLaneHeight: DEFAULT_GLOBAL_VIEW_SETTINGS.stageBorderMinimumLaneHeight,
    drawZoomFactor: DEFAULT_GLOBAL_VIEW_SETTINGS.drawZoomFactor,
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
    | {
        readonly type: "COMPARISON_OPEN";
        readonly baselineTabID: number;
        readonly candidateTabID: number;
    }
    | { readonly type: "COMPARISON_SET_MODE"; readonly tabID: number; readonly mode: ComparisonMode }
    | { readonly type: "COMPARISON_SET_OPACITY"; readonly tabID: number; readonly opacity: number }
    | { readonly type: "COMPARISON_ALIGN_TO_BASELINE"; readonly tabID: number }
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
    | {
        readonly type: "KONATA_CHANGE_CUSTOM_COLORS";
        readonly scheme: Readonly<CustomColorScheme>;
    }
    | { readonly type: "KONATA_HIDE_FLUSHED_OPS"; readonly tabID: number; readonly enabled: boolean }
    | {
        readonly type: "KONATA_CHANGE_MINIMUM_LANE_HEIGHT";
        readonly setting: MinimumLaneHeightKey;
        readonly value: number;
    }
    | { readonly type: "KONATA_CHANGE_ZOOM_FACTOR"; readonly value: number }
    // 現行UIのRenderer操作をそのまま保つための移行用action。同期scrollを戻す段階で必要な操作だけ具体化する。
    | {
        readonly type: "KONATA_MUTATE_VIEW";
        readonly tabID: number;
        readonly mutation: (renderer: KonataRenderer) => void;
        // 比較表示では、各Rendererの現在位置を起点にした操作を別々に渡す。
        readonly baselineMutation?: (renderer: KonataRenderer) => void;
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

function createFindContext(): FindContext {
    return {
        targetPattern: "",
        requestID: 0,
        progress: null,
        result: null,
        message: "",
    };
}

// 旧Tabと同じく、1つの入力、その命令列、Renderer状態を同じ寿命で所有する。
export class Tab {
    readonly kind = "trace";
    private readonly loadAbortController_ = new AbortController();
    trace: ParsedTrace | null = null;
    loadState: LoadState = "loading";
    progress = 0;
    errorMessage = "";
    // 旧Tabと同じく、検索結果と取消IDはtraceごとに独立して保持する。
    readonly findContext = createFindContext();

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

// 比較Tabは元Tabの表示状態を変更せず、同じTraceを別Rendererから参照する。
// retainしたTraceだけを所有するため、元Tabを閉じてもOpStoreは比較Tabの間は生存する。
export class ComparisonTab {
    readonly kind = "comparison";
    readonly loadState: LoadState = "ready";
    readonly progress = 1;
    readonly errorMessage = "";
    readonly findContext = createFindContext();
    trace: ParsedTrace | null;
    baselineTrace: ParsedTrace | null;
    readonly renderer: KonataRenderer;
    readonly baselineRenderer: KonataRenderer;
    mode: ComparisonMode = "overlay";
    opacity = 0.5;

    constructor(
        readonly id: number,
        readonly fileName: string,
        readonly baselineFileName: string,
        readonly candidateFileName: string,
        readonly baselineSourceTabID: number,
        readonly candidateSourceTabID: number,
        baselineTrace: ParsedTrace,
        candidateTrace: ParsedTrace,
        baselineRenderer: KonataRenderer,
        candidateRenderer: KonataRenderer,
        public splitterPosition = DEFAULT_SPLITTER_POSITION,
    ) {
        this.baselineTrace = baselineTrace.retain();
        this.trace = candidateTrace.retain();
        this.baselineRenderer = baselineRenderer;
        this.renderer = candidateRenderer;
        this.baselineRenderer.setTrace(this.baselineTrace);
        this.renderer.setTrace(this.trace);
    }

    alignCandidateToBaseline(): number | null {
        const baseline = this.baselineRenderer;
        const candidate = this.renderer;
        const originalBaselinePosition = baseline.viewPosition;
        const adjustedBaselinePosition = baseline.getAdjustedViewPosition();
        if (adjustedBaselinePosition === null) {
            return null;
        }

        // Alignだけで見失った位置からも復帰できるよう、先にAへAdjust positionを適用する。
        baseline.moveLogicalPosition(adjustedBaselinePosition);
        const baselineTop = baseline.getOpFromPixelPositionY(0);
        if (baselineTop === undefined || baselineTop.rid < 0) {
            baseline.moveLogicalPosition(originalBaselinePosition);
            return null;
        }

        // flush命令とretire命令が同じRIDを持つ場合は、両traceともretire命令を基準にする。
        const baselineAnchor = baseline.getOpFromRID(baselineTop.rid) ?? baselineTop;
        const candidateAnchor = candidate.getOpFromRID(baselineAnchor.rid);
        if (candidateAnchor === undefined) {
            // 共通RIDがなければAだけが動く中途半端な結果を残さない。
            baseline.moveLogicalPosition(originalBaselinePosition);
            return null;
        }

        const baselineY = baseline.hideFlushedOps ? baselineAnchor.rid : baselineAnchor.id;
        const candidateY = candidate.hideFlushedOps ? candidateAnchor.rid : candidateAnchor.id;
        const [baselineX, baselineTopY] = baseline.viewPosition;

        // Aは固定し、A上でanchorが見えている画面内offsetへB側の同じRIDを置く。
        candidate.zoomAbs(baseline.zoomLevel, 0, 0, false);
        candidate.moveLogicalPosition([
            candidateAnchor.fetchedCycle + baselineX - baselineAnchor.fetchedCycle,
            candidateY + baselineTopY - baselineY,
        ]);
        return baselineAnchor.rid;
    }

    close(): void {
        const candidateTrace = this.trace;
        const baselineTrace = this.baselineTrace;
        this.trace = null;
        this.baselineTrace = null;
        this.findContext.requestID++;
        this.findContext.progress = null;
        this.findContext.result = null;
        this.findContext.message = "";
        this.renderer.setTrace(null);
        this.baselineRenderer.setTrace(null);
        candidateTrace?.close();
        baselineTrace?.close();
    }
}

export type StoreTab = Tab | ComparisonTab;

export interface StoreSnapshot {
    readonly tabs: readonly Readonly<StoreTab>[];
    readonly activeTabID: number | null;
    readonly settings: Readonly<GlobalViewSettings>;
    readonly revision: number;
}

// 旧Storeのうち、tab状態の所有とACTION→CHANGEの一方向更新をWeb向けに復元する。
export class Store {
    private readonly tabs_ = new Map<number, StoreTab>();
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
            customColorScheme: viewSettings.customColorScheme,
            dependencyArrowType: viewSettings.dependencyArrowType,
            textLabelMinimumLaneHeight: viewSettings.textLabelMinimumLaneHeight,
            stageDetailMinimumLaneHeight: viewSettings.stageDetailMinimumLaneHeight,
            dependencyArrowMinimumLaneHeight: viewSettings.dependencyArrowMinimumLaneHeight,
            stageBorderMinimumLaneHeight: viewSettings.stageBorderMinimumLaneHeight,
            drawZoomFactor: viewSettings.drawZoomFactor,
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

    get activeTab(): StoreTab | null {
        const id = this.snapshot_.activeTabID;
        return id === null ? null : this.tabs_.get(id) ?? null;
    }

    get persistedViewSettings(): PersistedViewSettings {
        return {
            theme: this.settings_.theme,
            colorScheme: this.defaultColorScheme_,
            customColorScheme: this.settings_.customColorScheme,
            splitterPosition: this.defaultSplitterPosition_,
            dependencyArrowType: this.settings_.dependencyArrowType,
            textLabelMinimumLaneHeight: this.settings_.textLabelMinimumLaneHeight,
            stageDetailMinimumLaneHeight: this.settings_.stageDetailMinimumLaneHeight,
            dependencyArrowMinimumLaneHeight: this.settings_.dependencyArrowMinimumLaneHeight,
            stageBorderMinimumLaneHeight: this.settings_.stageBorderMinimumLaneHeight,
            drawZoomFactor: this.settings_.drawZoomFactor,
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
            if (tab === undefined || tab.kind !== "trace") {
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
            if (tab === undefined || tab.kind !== "trace") {
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
            if (tab === undefined || tab.kind !== "trace") {
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
            if (tab === undefined || tab.kind !== "trace") {
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
        case "COMPARISON_OPEN": {
            const baseline = this.tabs_.get(action.baselineTabID);
            const candidate = this.tabs_.get(action.candidateTabID);
            if (baseline?.kind !== "trace" || candidate?.kind !== "trace" ||
                baseline.id === candidate.id || baseline.loadState !== "ready" ||
                candidate.loadState !== "ready" || baseline.trace === null || candidate.trace === null) {
                return;
            }

            const baselineRenderer = new KonataRenderer();
            const candidateRenderer = new KonataRenderer();
            for (const renderer of [baselineRenderer, candidateRenderer]) {
                this.applyGlobalViewSettings_(renderer);
                // 色の違いをtrace差と誤認しないよう、比較中はCandidateの配色へ統一する。
                renderer.changeColorScheme(candidate.renderer.colorScheme);
                renderer.hideFlushedOps = candidate.renderer.hideFlushedOps;
            }
            const comparison = new ComparisonTab(
                this.nextOpenedTabID_++,
                `${baseline.fileName} ↔ ${candidate.fileName}`,
                baseline.fileName,
                candidate.fileName,
                baseline.id,
                candidate.id,
                baseline.trace,
                candidate.trace,
                baselineRenderer,
                candidateRenderer,
                candidate.splitterPosition,
            );
            // 比較元の位置関係はそのまま残し、以後は旧sync scrollと同じ相対操作で動かす。
            // overlayの縮尺だけは最初から一致させ、同じ移動量が同じ画面距離になるようにする。
            comparison.baselineRenderer.zoomAbs(candidate.renderer.zoomLevel, 0, 0, false);
            comparison.baselineRenderer.moveLogicalPosition(baseline.renderer.viewPosition);
            comparison.renderer.zoomAbs(candidate.renderer.zoomLevel, 0, 0, false);
            comparison.renderer.moveLogicalPosition(candidate.renderer.viewPosition);
            this.tabs_.set(comparison.id, comparison);
            this.publish_(comparison.id, [
                { type: "TAB_OPEN", tabID: comparison.id },
                { type: "TAB_UPDATE", tabID: comparison.id },
                { type: "PANE_CONTENT_UPDATE", tabID: comparison.id },
            ]);
            return;
        }
        case "COMPARISON_SET_MODE": {
            const tab = this.tabs_.get(action.tabID);
            if (tab?.kind !== "comparison") {
                return;
            }
            tab.mode = action.mode;
            this.publish_(this.snapshot_.activeTabID, [
                { type: "PANE_CONTENT_UPDATE", tabID: tab.id },
            ]);
            return;
        }
        case "COMPARISON_SET_OPACITY": {
            const tab = this.tabs_.get(action.tabID);
            if (tab?.kind !== "comparison" || !Number.isFinite(action.opacity)) {
                return;
            }
            tab.opacity = Math.max(0, Math.min(1, action.opacity));
            this.publish_(this.snapshot_.activeTabID, [
                { type: "PANE_CONTENT_UPDATE", tabID: tab.id },
            ]);
            return;
        }
        case "COMPARISON_ALIGN_TO_BASELINE": {
            const tab = this.tabs_.get(action.tabID);
            if (tab?.kind !== "comparison") {
                return;
            }
            if (tab.alignCandidateToBaseline() === null) {
                console.warn("Could not align to A: no common retired instruction was found at the top of A.");
                return;
            }
            this.publish_(this.snapshot_.activeTabID, [
                { type: "PANE_CONTENT_UPDATE", tabID: tab.id },
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
            for (const renderer of this.getRenderers_(tab)) {
                renderer.changeColorScheme(action.scheme);
            }
            this.publish_(this.snapshot_.activeTabID, [
                { type: "VIEW_SETTINGS_UPDATE" },
                { type: "PANE_CONTENT_UPDATE", tabID: tab.id },
            ]);
            return;
        }
        case "KONATA_CHANGE_CUSTOM_COLORS": {
            // Custom定義は旧Configと同じ全体設定なので、表示中かどうかに関係なく全Tabへ反映する。
            this.setGlobalViewSettings_({
                ...this.settings_,
                customColorScheme: action.scheme,
            }, false, true);
            return;
        }
        case "KONATA_HIDE_FLUSHED_OPS": {
            const tab = this.tabs_.get(action.tabID);
            if (tab === undefined) {
                return;
            }
            for (const renderer of this.getRenderers_(tab)) {
                // 表示方式を変えても、各traceで現在の先頭命令とそのfetch位置を維持する。
                const current = renderer.getOpFromPixelPositionY(0);
                const rid = current?.rid ?? 0;
                renderer.hideFlushedOps = action.enabled;
                const op = renderer.getOpFromRID(rid);
                if (op !== undefined) {
                    renderer.moveLogicalPosition([op.fetchedCycle, action.enabled ? rid : op.id]);
                }
            }
            this.publish_(this.snapshot_.activeTabID, [
                { type: "PANE_CONTENT_UPDATE", tabID: tab.id },
            ]);
            return;
        }
        case "KONATA_CHANGE_MINIMUM_LANE_HEIGHT": {
            this.setGlobalViewSettings_(
                { ...this.settings_, [action.setting]: action.value },
                false,
                true,
            );
            return;
        }
        case "KONATA_CHANGE_ZOOM_FACTOR": {
            if (!Number.isFinite(action.value) || action.value <= 0) {
                return;
            }
            this.setGlobalViewSettings_(
                { ...this.settings_, drawZoomFactor: action.value },
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
            if (tab.kind === "comparison" && action.baselineMutation !== undefined) {
                action.baselineMutation(tab.baselineRenderer);
            }
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
            for (const renderer of this.getRenderers_(tab)) {
                this.applyGlobalViewSettings_(renderer);
            }
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

    private getRenderers_(tab: StoreTab): readonly KonataRenderer[] {
        return tab.kind === "comparison"
            ? [tab.renderer, tab.baselineRenderer]
            : [tab.renderer];
    }

    private applyGlobalViewSettings_(renderer: KonataRenderer): void {
        const settings = this.settings_;
        renderer.setTheme(settings.theme);
        renderer.setCustomColorSchemes({ Custom: settings.customColorScheme });
        renderer.dependencyArrowType = settings.dependencyArrowType;
        renderer.splitLanes = settings.splitLanes;
        renderer.fixOpHeight = settings.fixOpHeight;
        renderer.textLabelMinimumLaneHeight = settings.textLabelMinimumLaneHeight;
        renderer.stageDetailMinimumLaneHeight = settings.stageDetailMinimumLaneHeight;
        renderer.dependencyArrowMinimumLaneHeight = settings.dependencyArrowMinimumLaneHeight;
        renderer.stageBorderMinimumLaneHeight = settings.stageBorderMinimumLaneHeight;
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
