import {
    type ChangeEvent,
    type DragEvent,
    useCallback,
    useEffect,
    useRef,
    useState,
    useSyncExternalStore,
} from "react";
import {
    BsArrowCounterclockwise,
    BsBarChart,
    BsBookmark,
    BsCrosshair,
    BsFolder2Open,
    BsPencil,
    BsSearch,
    BsSliders,
    BsZoomIn,
    BsZoomOut,
} from "react-icons/bs";

import { CommandPalette } from "./components/command_palette";
import { CustomColorDialog } from "./components/custom_color_dialog";
import { StatsDialog } from "./components/stats_dialog";
import { TabBar } from "./components/tab_bar";
import {
    TraceSheet,
    type TraceSheetHandle,
} from "./components/trace_sheet";
import type { Op, ParsedTrace } from "./core/model";
import { Gem5O3PipeViewParser } from "./core/gem5_o3_pipe_view_parser";
import { OnikiriParser } from "./core/onikiri_parser";
import { SerializedPageOpStore } from "./core/serialized_page_op_store";
import { calculateStats, type StatsValues } from "./core/stats";
import {
    DEFAULT_CUSTOM_COLOR_SCHEME,
    DEP_ARROW_TYPE,
    KonataRenderer,
    type CustomColorComponent,
    type CustomColorDefinition,
    type CustomColorScheme,
    type DependencyArrowType,
    type RendererTheme,
} from "./renderer/konata_renderer";
import {
    DEFAULT_PERSISTED_VIEW_SETTINGS,
    DEFAULT_SPLITTER_POSITION,
    type FindResult,
    type MinimumLaneHeightKey,
    type PersistedViewSettings,
    Store,
} from "./store";

interface ViewBookmark {
    readonly x: number;
    readonly y: number;
    readonly zoom: number;
}

interface ViewAnimation {
    readonly tabID: number;
    readonly startedAt: number;
    readonly duration: number;
    readonly apply: (renderer: KonataRenderer, progress: number) => void;
    frameID: number;
}

interface PendingScroll {
    readonly tabID: number;
    readonly position: readonly [number, number];
}

interface PendingZoom {
    readonly tabID: number;
    readonly level: number;
}

// 各詳細を描画するlaneの最小高さと、UIの説明を1か所で対応付ける。
const MINIMUM_LANE_HEIGHTS: ReadonlyArray<readonly [MinimumLaneHeightKey, string, string]> = [
    [
        "textLabelMinimumLaneHeight",
        "Text labels",
        "Show text labels when the lane is taller than this value.",
    ],
    [
        "stageDetailMinimumLaneHeight",
        "Stage details",
        "Draw individual lanes and stages when the lane is taller than this value.",
    ],
    [
        "dependencyArrowMinimumLaneHeight",
        "Dependency arrows",
        "Show dependency arrows when the lane is taller than this value.",
    ],
    [
        "stageBorderMinimumLaneHeight",
        "Stage borders",
        "Show stage borders when the lane is taller than this value.",
    ],
];

const INITIAL_BOOKMARKS: readonly ViewBookmark[] = Array.from(
    { length: 10 },
    () => ({ x: 0, y: 0, zoom: 0 }),
);
const BOOKMARK_STORAGE_KEY = "konata.bookmarks";
const COMMAND_HISTORY_STORAGE_KEY = "konata.commandHistory";
const VIEW_SETTINGS_STORAGE_KEY = "konata.viewSettings";
const MAX_COMMAND_HISTORY = 20;
// 旧版と同じ速度を保ち、操作方法だけに依存せず同じ補間を適用する。
const ZOOM_ANIMATION_DURATION = 80;
const SCROLL_ANIMATION_DURATION = 100;
const BOOKMARK_ANIMATION_DURATION = 200;
const BOOKMARK_ZOOM_ANIMATION_DURATION = 160;
const PIPELINE_COLOR_SCHEMES = new Set([
    "Auto",
    "Unique",
    "ThreadID",
    "Orange",
    "RoyalBlue",
    "Custom",
]);

function isNonNegativeFiniteNumber(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isPositiveFiniteNumber(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isCustomColorComponent(value: unknown): value is CustomColorComponent {
    return value === "auto" ||
        (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100);
}

function isCustomColorDefinition(value: unknown): value is CustomColorDefinition {
    if (typeof value !== "object" || value === null) {
        return false;
    }
    const color = value as Partial<Record<keyof CustomColorDefinition, unknown>>;
    return typeof color.h === "number" && Number.isFinite(color.h) && color.h >= 0 && color.h < 360 &&
        isCustomColorComponent(color.s) && isCustomColorComponent(color.l);
}

function isCustomColorScheme(value: unknown): value is CustomColorScheme {
    if (typeof value !== "object" || value === null) {
        return false;
    }
    const scheme = value as Record<string, unknown>;
    if (!isCustomColorDefinition(scheme.defaultColor)) {
        return false;
    }
    return Object.entries(scheme).every(([laneName, lane]) => {
        if (laneName === "defaultColor") {
            return true;
        }
        return typeof lane === "object" && lane !== null &&
            Object.values(lane).every(isCustomColorDefinition);
    });
}

function parsePersistedViewSettings(value: unknown): PersistedViewSettings | null {
    if (typeof value !== "object" || value === null) {
        return null;
    }
    const settings = value as Partial<Record<keyof PersistedViewSettings, unknown>> & Record<string, unknown>;
    // 旧Web版のthreshold名は読み込みだけ許容し、次回保存時に現在の名称へ移行する。
    const readRenamedSetting = (name: keyof PersistedViewSettings, oldName: string): unknown =>
        settings[name] === undefined ? settings[oldName] : settings[name];
    const textLabelMinimumLaneHeight = readRenamedSetting(
        "textLabelMinimumLaneHeight",
        "drawTextThreshold",
    );
    const stageDetailMinimumLaneHeight = readRenamedSetting(
        "stageDetailMinimumLaneHeight",
        "drawDetailedlyThreshold",
    );
    const dependencyArrowMinimumLaneHeight = readRenamedSetting(
        "dependencyArrowMinimumLaneHeight",
        "drawDependencyThreshold",
    );
    const stageBorderMinimumLaneHeight = readRenamedSetting(
        "stageBorderMinimumLaneHeight",
        "drawFrameThreshold",
    );
    // 既存Web版の保存値にはzoom factorがないため、他の設定を保ったまま旧既定値を補う。
    const drawZoomFactor = settings.drawZoomFactor === undefined
        ? DEFAULT_PERSISTED_VIEW_SETTINGS.drawZoomFactor
        : settings.drawZoomFactor;
    if ((settings.theme !== "dark" && settings.theme !== "light") ||
        typeof settings.colorScheme !== "string" ||
        !PIPELINE_COLOR_SCHEMES.has(settings.colorScheme) ||
        !isNonNegativeFiniteNumber(settings.splitterPosition) ||
        (settings.dependencyArrowType !== DEP_ARROW_TYPE.INSIDE_LINE &&
            settings.dependencyArrowType !== DEP_ARROW_TYPE.LEFT_SIDE_CURVE &&
            settings.dependencyArrowType !== DEP_ARROW_TYPE.NOT_SHOW) ||
        !isNonNegativeFiniteNumber(textLabelMinimumLaneHeight) ||
        !isNonNegativeFiniteNumber(stageDetailMinimumLaneHeight) ||
        !isNonNegativeFiniteNumber(dependencyArrowMinimumLaneHeight) ||
        !isNonNegativeFiniteNumber(stageBorderMinimumLaneHeight) ||
        !isPositiveFiniteNumber(drawZoomFactor)) {
        return null;
    }
    return {
        theme: settings.theme,
        colorScheme: settings.colorScheme,
        // 旧Web版の保存値にはこのfieldがないため、他の設定を捨てず既定配色で補う。
        customColorScheme: isCustomColorScheme(settings.customColorScheme)
            ? settings.customColorScheme
            : DEFAULT_CUSTOM_COLOR_SCHEME,
        splitterPosition: settings.splitterPosition,
        dependencyArrowType: settings.dependencyArrowType,
        textLabelMinimumLaneHeight,
        stageDetailMinimumLaneHeight,
        dependencyArrowMinimumLaneHeight,
        stageBorderMinimumLaneHeight,
        drawZoomFactor,
    };
}

function loadViewSettings(): Readonly<PersistedViewSettings> {
    try {
        const value: unknown = JSON.parse(localStorage.getItem(VIEW_SETTINGS_STORAGE_KEY) ?? "null");
        const settings = parsePersistedViewSettings(value);
        if (settings !== null) {
            return settings;
        }
    }
    catch {
        // file://でstorageを利用できない場合や保存値が壊れていても、起動は妨げない。
    }
    return DEFAULT_PERSISTED_VIEW_SETTINGS;
}

function saveViewSettings(settings: Readonly<PersistedViewSettings>): void {
    try {
        localStorage.setItem(VIEW_SETTINGS_STORAGE_KEY, JSON.stringify(settings));
    }
    catch {
        // 保存できなくても、現在のStore内では変更した表示設定をそのまま利用できる。
    }
}

function loadCommandHistory(): string[] {
    try {
        const value: unknown = JSON.parse(localStorage.getItem(COMMAND_HISTORY_STORAGE_KEY) ?? "null");
        if (Array.isArray(value) && value.every((command) => typeof command === "string")) {
            return value.slice(0, MAX_COMMAND_HISTORY);
        }
    }
    catch {
        // 保存値が壊れていてもpaletteの起動を妨げず、空の履歴から再開する。
    }
    return [];
}

function saveCommandHistory(history: readonly string[]): void {
    try {
        localStorage.setItem(COMMAND_HISTORY_STORAGE_KEY, JSON.stringify(history));
    }
    catch {
        // 保存できなくても、現在のApp内の履歴はそのまま利用できる。
    }
}

function isViewBookmark(value: unknown): value is ViewBookmark {
    if (typeof value !== "object" || value === null) {
        return false;
    }
    const bookmark = value as Partial<Record<keyof ViewBookmark, unknown>>;
    return typeof bookmark.x === "number" && Number.isFinite(bookmark.x) &&
        typeof bookmark.y === "number" && Number.isFinite(bookmark.y) &&
        typeof bookmark.zoom === "number" && Number.isFinite(bookmark.zoom);
}

function loadBookmarks(): readonly ViewBookmark[] {
    try {
        const value: unknown = JSON.parse(localStorage.getItem(BOOKMARK_STORAGE_KEY) ?? "null");
        if (Array.isArray(value) &&
            value.length === INITIAL_BOOKMARKS.length &&
            value.every(isViewBookmark)) {
            return value;
        }
    }
    catch {
        // file://でstorageを利用できない場合や保存値が壊れていても、起動は妨げない。
    }
    return INITIAL_BOOKMARKS;
}

function saveBookmarks(bookmarks: readonly ViewBookmark[]): void {
    try {
        localStorage.setItem(BOOKMARK_STORAGE_KEY, JSON.stringify(bookmarks));
    }
    catch {
        // bookmarkを保存できなくても、現在の画面内ではそのまま利用できる。
    }
}

// 旧Storeと同じく、命令の見出し・詳細・全stage labelを正規表現検索の対象にする。
function makeFindTargetString(op: Op): string {
    let labelString =
        `${op.id}: s${op.gid} (t${op.tid}: r${op.rid}) ${op.labelName}\n${op.labelDetail}`;
    for (const lane of op.lanes.values()) {
        for (const stage of lane.stages) {
            if (stage.labels !== "") {
                labelString += `\n${stage.labels}`;
            }
        }
    }
    return labelString;
}

export function App() {
    const fileInputRef = useRef<HTMLInputElement>(null);
    const bookmarkControlsRef = useRef<HTMLDetailsElement>(null);
    const viewControlsRef = useRef<HTMLDetailsElement>(null);
    const traceSheetRef = useRef<TraceSheetHandle>(null);
    const emptyRendererRef = useRef(new KonataRenderer());
    const storeRef = useRef<Store | null>(null);
    if (storeRef.current === null) {
        storeRef.current = new Store(loadViewSettings());
    }
    const store = storeRef.current;
    const statsRequestRef = useRef(0);
    const commandHistoryRef = useRef<string[] | null>(null);
    if (commandHistoryRef.current === null) {
        commandHistoryRef.current = loadCommandHistory();
    }
    const commandHistory = commandHistoryRef.current;
    // timer IDなどの途中状態は表示結果ではないため、StoreではなくAppの寿命にだけ結び付ける。
    const viewAnimationRef = useRef<ViewAnimation | null>(null);
    const pendingScrollRef = useRef<PendingScroll | null>(null);
    const pendingZoomRef = useRef<PendingZoom | null>(null);

    const { tabs, activeTabID, settings } = useSyncExternalStore(store.subscribe, store.getSnapshot);
    const [isDraggingFile, setIsDraggingFile] = useState(false);
    const [statsProgress, setStatsProgress] = useState<number | null>(null);
    const [statsValues, setStatsValues] = useState<Readonly<StatsValues> | null>(null);
    const [statsError, setStatsError] = useState("");
    const [isStatsDialogOpen, setIsStatsDialogOpen] = useState(false);
    const [isCustomColorDialogOpen, setIsCustomColorDialogOpen] = useState(false);
    const [commandPaletteInitial, setCommandPaletteInitial] = useState<string | null>(null);
    const [commandMessage, setCommandMessage] = useState("");
    // 旧版と同じ10枠だけを読み込み、設定全体を扱う新しい層は設けない。
    const [bookmarks, setBookmarks] = useState<readonly ViewBookmark[]>(loadBookmarks);
    // CanvasはReact DOMを持たないため、Rendererのview変更を再描画へ結び付ける番号を持つ。
    const [renderVersion, setRenderVersion] = useState(0);

    const activeTab = store.activeTab;
    const trace = activeTab?.trace ?? null;
    const loadState = activeTab?.loadState ?? "idle";
    const fileName = activeTab?.fileName ?? "";
    const progress = activeTab?.progress ?? 0;
    const errorMessage = activeTab?.errorMessage ?? "";
    const renderer = activeTab?.renderer ?? emptyRendererRef.current;
    const searchProgress = activeTab?.findContext.progress ?? null;
    const findResult = activeTab?.findContext.result ?? null;
    const searchMessage = activeTab?.findContext.message ?? "";

    useEffect(() => {
        saveBookmarks(bookmarks);
    }, [bookmarks]);

    const resetStats = useCallback(() => {
        statsRequestRef.current++;
        setStatsProgress(null);
        setStatsValues(null);
        setStatsError("");
        setIsStatsDialogOpen(false);
    }, []);

    const resetCommandUI = useCallback(() => {
        setCommandMessage("");
        setCommandPaletteInitial(null);
    }, []);

    const cancelViewAnimation = useCallback(() => {
        pendingScrollRef.current = null;
        pendingZoomRef.current = null;
        const animation = viewAnimationRef.current;
        if (animation === null) {
            return;
        }
        cancelAnimationFrame(animation.frameID);
        viewAnimationRef.current = null;
    }, []);

    const startViewAnimation = useCallback((
        duration: number,
        apply: (renderer: KonataRenderer, progress: number) => void,
    ) => {
        const tab = store.activeTab;
        if (tab === null) {
            return;
        }

        cancelViewAnimation();
        traceSheetRef.current?.clearToolTip();
        const tabID = tab.id;

        const animation: ViewAnimation = {
            tabID,
            startedAt: performance.now(),
            duration,
            apply,
            frameID: 0,
        };
        const animate = (now: number) => {
            if (viewAnimationRef.current !== animation) {
                return;
            }
            // Tab切替後に、以前のRendererを画面外で動かし続けない。
            if (store.activeTab?.id !== animation.tabID) {
                viewAnimationRef.current = null;
                pendingScrollRef.current = null;
                pendingZoomRef.current = null;
                return;
            }

            const progress = Math.max(
                0,
                Math.min(1, (now - animation.startedAt) / animation.duration),
            );
            store.dispatch({
                type: "KONATA_MUTATE_VIEW",
                tabID: animation.tabID,
                mutation: (renderer) => animation.apply(renderer, progress),
            });
            if (progress >= 1) {
                viewAnimationRef.current = null;
                pendingScrollRef.current = null;
                pendingZoomRef.current = null;
            }
            else {
                animation.frameID = requestAnimationFrame(animate);
            }
        };

        viewAnimationRef.current = animation;
        animation.frameID = requestAnimationFrame(animate);
    }, [cancelViewAnimation, store]);

    const hideSearchResult = useCallback(() => {
        const tab = store.activeTab;
        if (tab !== null) {
            store.dispatch({ type: "KONATA_FIND_HIDE_RESULT", tabID: tab.id });
        }
        resetCommandUI();
    }, [resetCommandUI, store]);

    const activateTab = useCallback((id: number) => {
        const previousTabID = store.activeTab?.id ?? null;
        cancelViewAnimation();
        store.dispatch({ type: "TAB_ACTIVATE", tabID: id });
        if (store.activeTab?.id === previousTabID) {
            return;
        }
        // dialogは閉じ、検索contextは切替先Tabが所有する値をそのまま表示する。
        resetStats();
        resetCommandUI();
    }, [cancelViewAnimation, resetCommandUI, resetStats, store]);

    const moveTab = useCallback((next: boolean): boolean => {
        const previousTabID = store.activeTab?.id ?? null;
        cancelViewAnimation();
        store.dispatch({ type: "TAB_MOVE", next });
        if (store.activeTab?.id === previousTabID) {
            return false;
        }
        resetStats();
        resetCommandUI();
        return true;
    }, [cancelViewAnimation, resetCommandUI, resetStats, store]);

    const closeTab = useCallback((id: number) => {
        const wasActive = store.activeTab?.id === id;
        if (wasActive) {
            cancelViewAnimation();
        }
        store.dispatch({ type: "TAB_CLOSE", tabID: id });
        if (wasActive) {
            resetStats();
            resetCommandUI();
        }
    }, [cancelViewAnimation, resetCommandUI, resetStats, store]);

    useEffect(() => store.subscribeChange((change) => {
        if (change.type === "VIEW_SETTINGS_UPDATE") {
            saveViewSettings(store.persistedViewSettings);
        }
        if (change.type === "PANE_CONTENT_UPDATE" &&
            (change.tabID === null || change.tabID === store.activeTab?.id)) {
            setRenderVersion((version) => version + 1);
        }
    }), [store]);

    useEffect(() => () => {
        statsRequestRef.current++;
        cancelViewAnimation();
        // StrictModeの初回cleanup時点ではtabがなく、実際のunmountではStoreが全tabを閉じる。
        store.close();
    }, [cancelViewAnimation, store]);

    const loadFile = useCallback(async (file: File) => {
        cancelViewAnimation();
        store.dispatch({
            type: "FILE_OPEN",
            fileName: file.name,
            renderer: new KonataRenderer(),
        });
        const tab = store.activeTab;
        if (tab === null) {
            return;
        }
        resetStats();
        resetCommandUI();

        let parsingTrace: ParsedTrace | null = null;
        // Parserが形式を確定してtraceを公開するまでは、Appが未公開storeの解放を受け持つ。
        let unpublishedStore: SerializedPageOpStore | null = null;
        const closeUnpublishedStore = () => {
            unpublishedStore?.close();
            unpublishedStore = null;
        };
        try {
            const updateProgress = (value: number) => {
                store.dispatch({ type: "FILE_LOAD_PROGRESS", tabID: tab.id, progress: value });
            };
            const updateTrace = (partialTrace: ParsedTrace) => {
                // 形式確定後は同じtraceを更新し、Storeから対象sheetの再描画を通知する。
                parsingTrace = partialTrace;
                unpublishedStore = null;
                store.dispatch({ type: "FILE_LOAD_TRACE", tabID: tab.id, trace: partialTrace });
            };
            let parsedTrace: ParsedTrace;
            try {
                unpublishedStore = await SerializedPageOpStore.createZstd();
                parsedTrace = await new OnikiriParser(unpublishedStore).parse(
                    file,
                    updateProgress,
                    updateTrace,
                    tab.loadSignal,
                );
            }
            catch (error) {
                // 現行版と同じ順序で試し、Kanataとして不正な入力だけをgem5へ渡す。
                if (!(error instanceof Error) || error.message !== "The selected file is not a Kanata trace.") {
                    throw error;
                }
                closeUnpublishedStore();
                unpublishedStore = await SerializedPageOpStore.createZstd();
                parsedTrace = await new Gem5O3PipeViewParser(unpublishedStore).parse(
                    file,
                    updateProgress,
                    updateTrace,
                    tab.loadSignal,
                );
            }
            // 空入力などを除き通常はupdateTraceで所有権が移るが、完了値もtrace自身がstoreを所有する。
            unpublishedStore = null;
            store.dispatch({ type: "FILE_LOAD_FINISH", tabID: tab.id, trace: parsedTrace });
        }
        catch (error) {
            closeUnpublishedStore();
            // close済みTabの意図的なcancelは、別Tabへerrorとして表示しない。
            if (tab.loadSignal.aborted) {
                return;
            }
            store.dispatch({
                type: "FILE_LOAD_ERROR",
                tabID: tab.id,
                message: error instanceof Error ? error.message : String(error),
                trace: parsingTrace,
            });
        }
    }, [cancelViewAnimation, resetCommandUI, resetStats, store]);

    const handleFileInput = (event: ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        if (file !== undefined) {
            void loadFile(file);
        }
        // 同じファイルを再選択してもchangeが発火するようvalueを戻す。
        event.target.value = "";
    };

    const handleDrop = (event: DragEvent<HTMLElement>) => {
        event.preventDefault();
        setIsDraggingFile(false);
        const file = event.dataTransfer.files[0];
        if (file !== undefined) {
            void loadFile(file);
        }
    };

    const mutateView = useCallback((mutation: (renderer: KonataRenderer) => void) => {
        // drag、pinchなど入力自体が連続する操作は、途中の値を起点に即座に引き継ぐ。
        cancelViewAnimation();
        traceSheetRef.current?.clearToolTip();
        const tab = store.activeTab;
        if (tab === null) {
            mutation(emptyRendererRef.current);
            setRenderVersion((version) => version + 1);
            return;
        }
        store.dispatch({ type: "KONATA_MUTATE_VIEW", tabID: tab.id, mutation });
    }, [cancelViewAnimation, store]);

    const scrollTo = useCallback((position: readonly [number, number]) => {
        const renderer = store.activeTab?.renderer;
        if (renderer === undefined) {
            return;
        }
        const [fromX, fromY] = renderer.viewPosition;
        const [toX, toY] = position;
        startViewAnimation(SCROLL_ANIMATION_DURATION, (target, progress) => {
            target.moveLogicalPosition([
                fromX + (toX - fromX) * progress,
                fromY + (toY - fromY) * progress,
            ]);
        });
    }, [startViewAnimation, store]);

    const moveView = useCallback((
        difference: readonly [number, number],
        adjustHorizontal: boolean,
    ) => {
        const tab = store.activeTab;
        if (tab === null) {
            return;
        }
        const pending = pendingScrollRef.current;
        const [baseX, baseY] = pending?.tabID === tab.id
            ? pending.position
            : tab.renderer.viewPosition;
        const differenceX = adjustHorizontal
            ? tab.renderer.adjustScrollDifferenceXAt([baseX, baseY], difference[1])
            : difference[0];
        const target: readonly [number, number] = [
            baseX + differenceX,
            baseY + difference[1],
        ];

        // 連続入力は未到達の終点へ加算し、現在の描画位置から滑らかに引き直す。
        scrollTo(target);
        pendingScrollRef.current = { tabID: tab.id, position: target };
    }, [scrollTo, store]);

    const adjustPosition = useCallback(() => {
        const target = store.activeTab?.renderer.getAdjustedViewPosition();
        if (target !== null && target !== undefined) {
            // 見失った位置からの移動経路が分かるよう、通常scrollと同じ補間を使う。
            scrollTo(target);
        }
    }, [scrollTo, store]);

    const moveSplitter = useCallback((position: number) => {
        const tab = store.activeTab;
        if (tab !== null) {
            store.dispatch({ type: "PANE_SPLITTER_MOVE", tabID: tab.id, position });
        }
    }, [store]);

    const openCommandPalette = useCallback((initialCommand: string) => {
        if (isStatsDialogOpen || isCustomColorDialogOpen) {
            return;
        }
        setCommandMessage("");
        setCommandPaletteInitial(initialCommand);
    }, [isCustomColorDialogOpen, isStatsDialogOpen]);

    const findString = useCallback((target: string, basePosition: number, reverse: boolean): void => {
        let targetPattern: RegExp;
        try {
            targetPattern = new RegExp(target);
        }
        catch (error) {
            setCommandMessage(`"${target}" is an invalid regular expression. ${String(error)}`);
            return;
        }

        const searchedTab = store.activeTab;
        const activeTrace = searchedTab?.trace ?? null;
        if (searchedTab === null || activeTrace === null) {
            setCommandMessage("No trace is open.");
            return;
        }

        // viewportは検索開始時の対象Tabの値を使い、別Tabへ切り替わっても混同しない。
        const viewport = traceSheetRef.current?.getViewportSize();
        store.dispatch({ type: "KONATA_FIND_START", tabID: searchedTab.id, targetPattern: target });
        const requestID = searchedTab.findContext.requestID;
        setCommandMessage("");

        void (async () => {
            const isCanceled = () =>
                searchedTab.findContext.requestID !== requestID || searchedTab.trace !== activeTrace;
            // 旧検索と同じく現在位置の次から始め、末尾では先頭へ折り返す。
            const lastOpID = activeTrace.lastID;
            let current = basePosition;
            // WebモデルのlastIDは最大IDを含むため、旧処理の意図どおり全IDを巡回できる境界にする。
            if (current < 0 || current > lastOpID) {
                current = 0;
            }

            const sleepPeriod = 1024 * 8;
            let previousSleepTime = Date.now();
            const startTime = previousSleepTime;
            let foundOp: Op | undefined;

            for (let index = 0; index <= lastOpID; index++) {
                current += reverse ? -1 : 1;
                if (current < 0) {
                    current = lastOpID;
                }
                else if (current > lastOpID) {
                    current = 0;
                }

                const op = activeTrace.getOpForScan(current);
                if (op !== undefined && targetPattern.test(makeFindTargetString(op))) {
                    foundOp = op;
                    break;
                }

                // 大きなtraceでもUI操作で新しい検索へ切り替えられるよう、旧版と同じ間隔でyieldする。
                if (index % sleepPeriod === 0 && previousSleepTime + 100 < Date.now()) {
                    previousSleepTime = Date.now();
                    store.dispatch({
                        type: "KONATA_FIND_PROGRESS",
                        tabID: searchedTab.id,
                        requestID,
                        progress: lastOpID > 0 ? index / lastOpID : 1,
                    });
                    await new Promise((resolve) => setTimeout(resolve, 17));
                    if (isCanceled()) {
                        return;
                    }
                }
            }

            console.log(`Search finished: ${target}@${foundOp?.id ?? -1}, ${Date.now() - startTime} msec`);
            if (isCanceled()) {
                return;
            }

            if (foundOp === undefined) {
                store.dispatch({
                    type: "KONATA_FIND_FINISH",
                    tabID: searchedTab.id,
                    requestID,
                    result: null,
                    message: `"${target}" was not found.`,
                });
                return;
            }

            const renderer = searchedTab.renderer;
            const viewPosition = renderer.viewPosition;
            const moveTo = renderer.getPositionYFromOp(foundOp);
            let left = viewPosition[0];
            let top = viewPosition[1];
            const pipelineWidth = viewport?.pipelineWidth ?? 800;
            const labelHeight = viewport?.labelHeight ?? 400;

            // ヒットした命令が画面外の場合だけ、旧版と同じく100pxの余白を付けて移動する。
            if (foundOp.fetchedCycle < left ||
                foundOp.fetchedCycle > left + pipelineWidth / renderer.opWidth) {
                left = foundOp.fetchedCycle - 100 / renderer.opWidth;
            }
            if (moveTo < top || moveTo > top + labelHeight / renderer.opHeight) {
                top = moveTo - 100 / renderer.opHeight;
            }

            const anchorOp = renderer.getVisibleOp(moveTo) ?? foundOp;
            const result: FindResult = {
                targetPattern: target,
                foundString: makeFindTargetString(foundOp),
                op: foundOp,
                anchorOp,
                flushed: foundOp.flush,
            };
            if (store.activeTab?.id === searchedTab.id) {
                scrollTo([left, top]);
            }
            else {
                // 非表示Tabではrunnerを維持せず、再表示時に最終位置だけを復元する。
                store.dispatch({
                    type: "KONATA_MUTATE_VIEW",
                    tabID: searchedTab.id,
                    mutation: (targetRenderer) => targetRenderer.moveLogicalPosition([left, top]),
                });
            }
            store.dispatch({
                type: "KONATA_FIND_FINISH",
                tabID: searchedTab.id,
                requestID,
                result,
                message: "",
            });
        })().catch((error) => {
            if (searchedTab.findContext.requestID === requestID) {
                store.dispatch({
                    type: "KONATA_FIND_FINISH",
                    tabID: searchedTab.id,
                    requestID,
                    result: null,
                    message: error instanceof Error ? error.message : String(error),
                });
            }
        });
    }, [scrollTo, store]);

    const repeatSearch = useCallback((reverse: boolean) => {
        if (findResult === null) {
            return;
        }
        const renderer = store.activeTab?.renderer ?? emptyRendererRef.current;
        const basePosition = renderer.getPositionYFromOp(findResult.anchorOp);
        findString(findResult.targetPattern, basePosition, reverse);
    }, [findResult, findString, store]);

    const executeCommand = useCallback((command: string) => {
        let accepted = false;
        const renderer = store.activeTab?.renderer ?? emptyRendererRef.current;
        const idMatch = command.match(/^j\s+(\d+)\s*$/);
        const ridMatch = command.match(/^jr\s+(\d+)\s*$/);
        const findMatch = command.match(/^f\s+(.+)$/);

        if (idMatch !== null) {
            hideSearchResult();
            const id = Number(idMatch[1]);
            const op = renderer.getVisibleOp(id);
            if (op === undefined) {
                setCommandMessage(`Op ${id} was not found.`);
            }
            else {
                scrollTo([op.fetchedCycle, id]);
            }
            accepted = true;
        }
        else if (ridMatch !== null) {
            hideSearchResult();
            const rid = Number(ridMatch[1]);
            const op = renderer.getOpFromRID(rid);
            const y = renderer.getPositionYFromRID(rid);
            if (op === undefined || y < 0) {
                setCommandMessage(`Retired op ${rid} was not found.`);
            }
            else {
                scrollTo([op.fetchedCycle, y]);
            }
            accepted = true;
        }
        else if (findMatch !== null) {
            findString(findMatch[1], Math.floor(renderer.viewPosition[1]), false);
            accepted = true;
        }
        else if (/^l(?:\s+.*)?$/.test(command)) {
            // Webではpathを直接開けないため、lは同じfile pickerを起動する。
            fileInputRef.current?.click();
            accepted = true;
        }
        else {
            setCommandMessage(`Failed to parse: ${command}`);
        }

        if (accepted) {
            commandHistory.unshift(command);
            if (commandHistory.length > MAX_COMMAND_HISTORY) {
                commandHistory.pop();
            }
            saveCommandHistory(commandHistory);
        }
        setCommandPaletteInitial(null);
    }, [commandHistory, findString, hideSearchResult, scrollTo, store]);

    const zoomAt = useCallback((factor: number, centerX: number, centerY: number) => {
        const tab = store.activeTab;
        if (tab === null || factor === 1) {
            return;
        }
        const renderer = tab.renderer;
        const fromLevel = renderer.zoomLevel;
        const pending = pendingZoomRef.current;
        // wheelなどが次のframeより速く届いても、各1段分を失わず目標倍率へ積み上げる。
        const baseLevel = pending?.tabID === tab.id ? pending.level : fromLevel;
        // 旧drawZoomFactorと同じく、値を大きくすると1操作あたりの倍率変化を細かくする。
        const zoomStep = 1 / settings.drawZoomFactor;
        const toLevel = renderer.clampZoomLevel(baseLevel + (factor > 1 ? -zoomStep : zoomStep));
        startViewAnimation(ZOOM_ANIMATION_DURATION, (target, progress) => {
            target.zoomAbs(fromLevel + (toLevel - fromLevel) * progress, centerX, centerY);
        });
        pendingZoomRef.current = { tabID: tab.id, level: toLevel };
    }, [settings.drawZoomFactor, startViewAnimation, store]);

    const zoomAtCenter = useCallback((factor: number) => {
        const viewport = traceSheetRef.current?.getViewportSize();
        if (viewport !== undefined) {
            zoomAt(factor, viewport.pipelineWidth / 2, viewport.pipelineHeight / 2);
        }
    }, [zoomAt]);

    const moveVertical = useCallback((delta: number, adjust: boolean) => {
        const renderer = store.activeTab?.renderer ?? emptyRendererRef.current;
        const differenceY = delta * 3 / renderer.zoomScale;
        moveView([0, differenceY], adjust);
    }, [moveView, store]);

    const moveHorizontal = useCallback((delta: number) => {
        const renderer = store.activeTab?.renderer ?? emptyRendererRef.current;
        const differenceX = delta * 6 / renderer.zoomScale;
        moveView([differenceX, 0], false);
    }, [moveView, store]);

    const setBookmark = useCallback((index: number) => {
        const renderer = store.activeTab?.renderer ?? emptyRendererRef.current;
        const [x, y] = renderer.viewPosition;
        // 旧Configの保存値と同じく、論理座標は整数へ切り下げる。
        const bookmark = { x: Math.floor(x), y: Math.floor(y), zoom: renderer.zoomLevel };
        setBookmarks((current) => current.map((value, position) =>
            position === index ? bookmark : value));
    }, [store]);

    const goToBookmark = useCallback((index: number) => {
        const bookmark = bookmarks[index];
        if (bookmark === undefined) {
            return;
        }
        const renderer = store.activeTab?.renderer ?? emptyRendererRef.current;
        const [fromX, fromY] = renderer.viewPosition;
        const fromZoom = renderer.zoomLevel;
        startViewAnimation(BOOKMARK_ANIMATION_DURATION, (target, progress) => {
            // 旧版同様にscrollとzoomを並行させ、bookmark座標をずらす補正は行わない。
            const zoomProgress = Math.min(
                1,
                progress * BOOKMARK_ANIMATION_DURATION / BOOKMARK_ZOOM_ANIMATION_DURATION,
            );
            target.zoomAbs(
                fromZoom + (bookmark.zoom - fromZoom) * zoomProgress,
                bookmark.x,
                bookmark.y,
                false,
            );
            target.moveLogicalPosition([
                fromX + (bookmark.x - fromX) * progress,
                fromY + (bookmark.y - fromY) * progress,
            ]);
        });
    }, [bookmarks, startViewAnimation, store]);

    const resetView = useCallback(() => {
        const renderer = store.activeTab?.renderer;
        if (renderer === undefined) {
            return;
        }
        const [fromX, fromY] = renderer.viewPosition;
        const fromZoom = renderer.zoomLevel;
        startViewAnimation(BOOKMARK_ANIMATION_DURATION, (target, progress) => {
            target.zoomAbs(fromZoom * (1 - progress), 0, 0, false);
            target.moveLogicalPosition([fromX * (1 - progress), fromY * (1 - progress)]);
        });
    }, [startViewAnimation, store]);

    const toggleHideFlushedOps = (enabled: boolean) => {
        if (activeTab !== null) {
            store.dispatch({ type: "KONATA_HIDE_FLUSHED_OPS", tabID: activeTab.id, enabled });
        }
    };

    const showStats = () => {
        if (trace === null || loadState === "loading" || statsProgress !== null) {
            return;
        }
        const requestID = ++statsRequestRef.current;
        setStatsProgress(0);
        setStatsValues(null);
        setStatsError("");
        setIsStatsDialogOpen(false);

        void calculateStats(
            trace,
            (value) => {
                if (statsRequestRef.current === requestID) {
                    setStatsProgress(value);
                }
            },
            () => statsRequestRef.current !== requestID || store.activeTab?.trace !== trace,
        ).then((values) => {
            if (statsRequestRef.current !== requestID || values === null) {
                return;
            }
            setStatsProgress(null);
            setStatsValues(values);
            setIsStatsDialogOpen(true);
        }).catch((error) => {
            if (statsRequestRef.current !== requestID) {
                return;
            }
            setStatsProgress(null);
            setStatsError(error instanceof Error ? error.message : String(error));
            setIsStatsDialogOpen(true);
        });
    };

    const closeStatsDialog = () => {
        setIsStatsDialogOpen(false);
        setStatsValues(null);
        setStatsError("");
    };

    useEffect(() => {
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.defaultPrevented) {
                return;
            }
            if (isCustomColorDialogOpen) {
                if (event.key === "Escape") {
                    setIsCustomColorDialogOpen(false);
                    event.preventDefault();
                }
                return;
            }
            if (isStatsDialogOpen) {
                if (event.key === "Escape") {
                    closeStatsDialog();
                    event.preventDefault();
                }
                return;
            }
            const commandKey = event.ctrlKey || event.metaKey;
            // browserが予約する環境では届かないが、受け取れた場合は旧native menuと同じ操作にする。
            if (commandKey && !event.altKey && event.key === "Tab" && moveTab(!event.shiftKey)) {
                event.preventDefault();
                return;
            }
            if (commandPaletteInitial !== null) {
                return;
            }
            if (commandKey && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "o") {
                fileInputRef.current?.click();
                event.preventDefault();
                return;
            }

            if (event.key === "F1" ||
                (commandKey && event.shiftKey && event.key.toLowerCase() === "p")) {
                openCommandPalette("");
                event.preventDefault();
                return;
            }
            if (commandKey && !event.shiftKey && event.key.toLowerCase() === "f") {
                openCommandPalette("f ");
                event.preventDefault();
                return;
            }
            if (trace === null) {
                return;
            }
            // View panelの入力中は、矢印や記号をCanvas操作として横取りしない。
            if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) {
                return;
            }

            const zoomKey = commandKey;
            let handled = true;
            if (event.key === "F3") {
                repeatSearch(event.shiftKey);
            }
            else if (event.key === "Escape" || event.key === "Enter") {
                hideSearchResult();
            }
            else if (event.key === "ArrowUp") {
                zoomKey ? zoomAtCenter(2) : moveVertical(-1, !event.shiftKey);
            }
            else if (event.key === "ArrowDown") {
                zoomKey ? zoomAtCenter(1 / 2) : moveVertical(1, !event.shiftKey);
            }
            else if (event.key === "PageUp") {
                moveVertical(-10, !zoomKey);
            }
            else if (event.key === "PageDown") {
                moveVertical(10, !zoomKey);
            }
            else if (event.key === "ArrowLeft") {
                moveHorizontal(-1);
            }
            else if (event.key === "ArrowRight") {
                moveHorizontal(1);
            }
            else if (event.key === "+") {
                zoomAtCenter(2);
            }
            else if (event.key === "-") {
                zoomAtCenter(1 / 2);
            }
            else if (/^[0-9]$/.test(event.key) && !event.altKey && !event.shiftKey) {
                const index = Number(event.key);
                commandKey ? setBookmark(index) : goToBookmark(index);
            }
            else {
                handled = false;
            }
            if (handled) {
                event.preventDefault();
            }
        };
        document.addEventListener("keydown", handleKeyDown);
        return () => document.removeEventListener("keydown", handleKeyDown);
    }, [commandPaletteInitial, goToBookmark, hideSearchResult, isCustomColorDialogOpen,
        isStatsDialogOpen, moveHorizontal, moveTab, moveVertical, openCommandPalette, repeatSearch,
        setBookmark, trace, zoomAtCenter]);

    let statusMessage = "Open or drop a Kanata or gem5 O3PipeView trace.";
    if (loadState === "loading") {
        statusMessage = `Loading ${fileName}… ${Math.round(progress * 100)}%`;
    }
    else if (loadState === "ready" && trace !== null) {
        statusMessage = `${trace.opCount.toLocaleString()} ops · ${trace.lastCycle.toLocaleString()} cycles · ${trace.laneNames.size.toLocaleString()} lanes`;
    }
    else if (loadState === "error") {
        statusMessage = errorMessage;
    }
    const visibleMessage = commandMessage !== "" ? commandMessage : searchMessage;
    if (visibleMessage !== "") {
        statusMessage = visibleMessage;
    }

    const operation = loadState === "loading"
        ? { type: "load", value: progress, label: `Loading ${fileName}` }
        : statsProgress !== null
            ? { type: "stats", value: statsProgress, label: "Calculating statistics" }
            : searchProgress !== null
                ? { type: "search", value: searchProgress, label: "Searching trace" }
                : null;

    return (
        <main
            className={`trace-app theme-${settings.theme}${isDraggingFile ? " is-dragging-file" : ""}`}
            data-theme={settings.theme}
            data-load-state={loadState}
            data-file-name={fileName}
            data-op-count={trace?.opCount ?? 0}
            data-lane-count={trace?.laneNames.size ?? 0}
            onClick={(event) => {
                // nativeのdetailsは外側clickで閉じないため、panel外だけを明示的に閉じる。
                for (const controls of [bookmarkControlsRef.current, viewControlsRef.current]) {
                    if (controls?.open && !controls.contains(event.target as Node)) {
                        controls.open = false;
                    }
                }
            }}
            onDragEnter={(event) => {
                event.preventDefault();
                setIsDraggingFile(true);
            }}
            onDragOver={(event) => event.preventDefault()}
            onDragLeave={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                    setIsDraggingFile(false);
                }
            }}
            onDrop={handleDrop}
        >
            {commandPaletteInitial !== null && (
                <CommandPalette
                    initialCommand={commandPaletteInitial}
                    history={commandHistory}
                    onExecute={executeCommand}
                    onClose={() => setCommandPaletteInitial(null)}
                />
            )}
            <TabBar
                tabs={tabs}
                activeTabID={activeTabID}
                onActivate={activateTab}
                onClose={closeTab}
            />
            <header className="app-toolbar">
                <input
                    ref={fileInputRef}
                    className="file-input"
                    type="file"
                    accept=".log,.txt,.gz,text/plain,application/gzip"
                    onChange={handleFileInput}
                />
                <button
                    className="primary-button button-with-icon toolbar-action"
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                >
                    <BsFolder2Open aria-hidden="true" />
                    <span>Open</span>
                </button>
                <button
                    className="button-with-icon toolbar-action"
                    type="button"
                    aria-label="Search trace"
                    title="Search trace"
                    disabled={trace === null || loadState === "loading"}
                    onClick={() => openCommandPalette("f ")}
                >
                    <BsSearch aria-hidden="true" />
                    <span>Search</span>
                </button>
                <details ref={bookmarkControlsRef} className="bookmark-controls">
                    <summary
                        className="toolbar-action"
                        aria-label="Bookmarks"
                        title="Bookmarks"
                        onClick={() => viewControlsRef.current?.removeAttribute("open")}
                    >
                        <BsBookmark aria-hidden="true" />
                        <span>Bookmark</span>
                    </summary>
                    <div className="bookmark-controls-panel">
                        <p>0–9: Go · Ctrl/⌘+0–9: Set</p>
                        {bookmarks.map((bookmark, index) => (
                            <div className="bookmark-row" key={index}>
                                <button
                                    type="button"
                                    aria-label={`Go to bookmark ${index}`}
                                    disabled={trace === null}
                                    onClick={() => goToBookmark(index)}
                                >
                                    Go
                                </button>
                                <output>{index}: x:{bookmark.x}, y:{bookmark.y}, zoom:{bookmark.zoom}</output>
                                <button
                                    type="button"
                                    aria-label={`Set bookmark ${index}`}
                                    disabled={trace === null}
                                    onClick={() => setBookmark(index)}
                                >
                                    Set
                                </button>
                            </div>
                        ))}
                    </div>
                </details>
                <button
                    className="button-with-icon toolbar-action"
                    type="button"
                    disabled={trace === null || loadState === "loading" || statsProgress !== null || searchProgress !== null}
                    onClick={showStats}
                >
                    <BsBarChart aria-hidden="true" />
                    <span>Stats</span>
                </button>
                <details ref={viewControlsRef} className="view-controls">
                    <summary
                        className="toolbar-action"
                        aria-label="View settings"
                        title="View settings"
                        onClick={() => bookmarkControlsRef.current?.removeAttribute("open")}
                    >
                        <BsSliders aria-hidden="true" />
                        <span>View</span>
                    </summary>
                    <div className="view-controls-panel">
                        <label title="Switch the interface and canvas between dark and light colors.">
                            Theme
                            <select
                                aria-label="UI color theme"
                                value={settings.theme}
                                onChange={(event) => store.dispatch({
                                    type: "KONATA_CHANGE_UI_COLOR_THEME",
                                    theme: event.target.value as RendererTheme,
                                })}
                            >
                                <option value="dark">Dark</option>
                                <option value="light">Light</option>
                            </select>
                        </label>
                        <label title="Hide flushed instructions and arrange the remaining instructions by retire ID.">
                            <input
                                type="checkbox"
                                aria-label="Hide flushed ops"
                                checked={renderer.hideFlushedOps}
                                disabled={trace === null}
                                onChange={(event) => toggleHideFlushedOps(event.target.checked)}
                            />
                            Hide flushed ops
                        </label>
                        <label title="Show each pipeline lane on a separate row.">
                            <input
                                type="checkbox"
                                aria-label="Split lanes"
                                checked={settings.splitLanes}
                                disabled={trace === null}
                                onChange={(event) => store.dispatch({
                                    type: "KONATA_SPLIT_LANES",
                                    enabled: event.target.checked,
                                })}
                            />
                            Split lanes
                        </label>
                        <label title="Keep each instruction at a fixed total height when lanes are split.">
                            <input
                                type="checkbox"
                                aria-label="Fix op height"
                                checked={settings.fixOpHeight}
                                disabled={trace === null || !settings.splitLanes}
                                onChange={(event) => store.dispatch({
                                    type: "KONATA_FIX_OP_HEIGHT",
                                    enabled: event.target.checked,
                                })}
                            />
                            Fix op height
                        </label>
                        <div className="custom-color-control">
                            <label title="Choose how pipeline stages are colored.">
                                Color
                                <select
                                    aria-label="Pipeline color scheme"
                                    value={renderer.colorScheme}
                                    disabled={trace === null}
                                    onChange={(event) => {
                                        if (activeTab !== null) {
                                            store.dispatch({
                                                type: "KONATA_CHANGE_COLOR_SCHEME",
                                                tabID: activeTab.id,
                                                scheme: event.target.value,
                                            });
                                        }
                                    }}
                                >
                                    <option>Auto</option>
                                    <option>Unique</option>
                                    <option>ThreadID</option>
                                    <option>Orange</option>
                                    <option>RoyalBlue</option>
                                    <option>Custom</option>
                                </select>
                            </label>
                            {renderer.colorScheme === "Custom" && (
                                <button
                                    className="button-with-icon"
                                    type="button"
                                    onClick={() => {
                                        viewControlsRef.current?.removeAttribute("open");
                                        setIsCustomColorDialogOpen(true);
                                    }}
                                >
                                    <BsPencil aria-hidden="true" />
                                    <span>Edit…</span>
                                </button>
                            )}
                        </div>
                        <label title="Choose how instruction dependencies are drawn.">
                            Dependency arrows
                            <select
                                aria-label="Dependency arrow type"
                                value={settings.dependencyArrowType}
                                disabled={trace === null}
                                onChange={(event) => store.dispatch({
                                    type: "KONATA_SET_DEP_ARROW_TYPE",
                                    arrowType: event.target.value as DependencyArrowType,
                                })}
                            >
                                <option value={DEP_ARROW_TYPE.INSIDE_LINE}>Inside-line</option>
                                <option value={DEP_ARROW_TYPE.LEFT_SIDE_CURVE}>Leftside-curve</option>
                                <option value={DEP_ARROW_TYPE.NOT_SHOW}>Not show</option>
                            </select>
                        </label>
                        <label title="Number of steps used to double or halve the zoom.">
                            Zoom steps per 2×
                            <input
                                type="number"
                                min="0.1"
                                step="0.1"
                                aria-label="Zoom steps per 2x"
                                value={settings.drawZoomFactor}
                                onChange={(event) => {
                                    const value = Number(event.target.value);
                                    if (Number.isFinite(value) && value > 0) {
                                        store.dispatch({ type: "KONATA_CHANGE_ZOOM_FACTOR", value });
                                    }
                                }}
                            />
                        </label>
                        <details className="drawing-thresholds">
                            <summary title="Larger values hide details sooner as you zoom out; smaller values keep them visible longer.">
                                Minimum lane height (px)
                            </summary>
                            {MINIMUM_LANE_HEIGHTS.map(([key, label, description]) => (
                                <label key={key} title={description}>
                                    {label}
                                    <input
                                        type="number"
                                        min="0"
                                        step="0.5"
                                        aria-label={`${label} minimum lane height`}
                                        value={settings[key]}
                                        disabled={trace === null}
                                        onChange={(event) => {
                                            const value = Number(event.target.value);
                                            if (Number.isFinite(value) && value >= 0) {
                                                store.dispatch({
                                                    type: "KONATA_CHANGE_MINIMUM_LANE_HEIGHT",
                                                    setting: key,
                                                    value,
                                                });
                                            }
                                        }}
                                    />
                                </label>
                            ))}
                        </details>
                    </div>
                </details>
                <div className="zoom-controls" aria-label="Zoom controls">
                    <button
                        className="icon-button"
                        type="button"
                        disabled={trace === null}
                        onClick={() => zoomAtCenter(1 / 1.2)}
                        aria-label="Zoom out"
                        title="Zoom out"
                    >
                        <BsZoomOut aria-hidden="true" />
                    </button>
                    <output>{renderer.zoomPercentLabel}</output>
                    <button
                        className="icon-button"
                        type="button"
                        disabled={trace === null}
                        onClick={() => zoomAtCenter(1.2)}
                        aria-label="Zoom in"
                        title="Zoom in"
                    >
                        <BsZoomIn aria-hidden="true" />
                    </button>
                    <span className="zoom-separator" aria-hidden="true" />
                    <button
                        className="icon-button"
                        type="button"
                        disabled={trace === null}
                        onClick={adjustPosition}
                        aria-label="Adjust position"
                        title="Adjust position"
                    >
                        <BsCrosshair aria-hidden="true" />
                    </button>
                    <button
                        className="icon-button"
                        type="button"
                        disabled={trace === null}
                        onClick={resetView}
                        aria-label="Reset view"
                        title="Reset view"
                    >
                        <BsArrowCounterclockwise aria-hidden="true" />
                        <span className="visually-hidden">Reset</span>
                    </button>
                </div>
                <p className={`status ${visibleMessage === "" ? `status-${loadState}` : "status-error"}`} role="status">
                    {statusMessage}
                </p>
                {operation !== null && (
                    <div
                        className={`operation-progress ${operation.type}`}
                        role="progressbar"
                        aria-label={operation.label}
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={Math.round(operation.value * 100)}
                    >
                        <div style={{ width: `${operation.value * 100}%` }} />
                    </div>
                )}
            </header>

            <TraceSheet
                key={activeTabID ?? "empty"}
                ref={traceSheetRef}
                renderer={renderer}
                trace={trace}
                loadState={loadState}
                errorMessage={errorMessage}
                renderVersion={renderVersion}
                findResult={findResult}
                splitterPosition={activeTab?.splitterPosition ?? DEFAULT_SPLITTER_POSITION}
                onMoveSplitter={moveSplitter}
                onMutateView={mutateView}
                onMoveView={moveView}
                onScrollView={scrollTo}
                onZoomView={zoomAt}
                onCloseFindResult={hideSearchResult}
                onOpenTrace={() => fileInputRef.current?.click()}
            />
            {isStatsDialogOpen && (
                <StatsDialog values={statsValues} error={statsError} onClose={closeStatsDialog} />
            )}
            {isCustomColorDialogOpen && trace !== null && (
                <CustomColorDialog
                    scheme={settings.customColorScheme}
                    trace={trace}
                    onChange={(scheme) => store.dispatch({
                        type: "KONATA_CHANGE_CUSTOM_COLORS",
                        scheme,
                    })}
                    onClose={() => setIsCustomColorDialogOpen(false)}
                />
            )}
        </main>
    );
}
