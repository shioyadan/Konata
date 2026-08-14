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
    BsArrowClockwise,
    BsArrowCounterclockwise,
    BsBarChart,
    BsBookmark,
    BsClockHistory,
    BsCrosshair,
    BsExclamationTriangleFill,
    BsFolder2Open,
    BsIntersect,
    BsPencil,
    BsSearch,
    BsSliders,
    BsZoomIn,
    BsZoomOut,
} from "react-icons/bs";

import { ApplicationMenu } from "./components/application_menu";
import { CommandPalette } from "./components/command_palette";
import { CustomColorDialog } from "./components/custom_color_dialog";
import { LogPane, type LogEntry, type LogLevel } from "./components/log_pane";
import { StatsDialog } from "./components/stats_dialog";
import { TabBar } from "./components/tab_bar";
import {
    TraceSheet,
    type TraceSheetHandle,
} from "./components/trace_sheet";
import { calculateStats, type StatsValues } from "./core/stats";
import {
    DEFAULT_CUSTOM_COLOR_SCHEME,
    DEFAULT_KONATA_RENDER_SPEC,
    DEP_ARROW_TYPE,
    clampKonataZoomLevel,
    formatKonataZoomPercent,
    getKonataZoomScale,
    type CustomColorComponent,
    type CustomColorDefinition,
    type CustomColorScheme,
    type DependencyArrowType,
    type RendererTheme,
} from "./core/konata_renderer";
import {
    DEFAULT_PERSISTED_VIEW_SETTINGS,
    DEFAULT_SPLITTER_POSITION,
    type MinimumLaneHeightKey,
    type PersistedViewSettings,
    Store,
} from "./store";
import { getRemoteTraceFileNames } from "./trace_file_access";

interface ViewBookmark {
    readonly x: number;
    readonly y: number;
    readonly zoom: number;
}

interface ViewAnimation {
    readonly tabID: number;
    readonly startedAt: number;
    readonly duration: number;
    readonly apply: (progress: number) => void;
    frameID: number;
}

interface PendingScroll {
    readonly tabID: number;
    readonly position: readonly [number, number];
    readonly baselinePosition?: readonly [number, number];
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
const MAX_LOG_ENTRIES = 500;
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
    const webGLEnabled = settings.webGLEnabled === undefined
        ? DEFAULT_PERSISTED_VIEW_SETTINGS.webGLEnabled
        : settings.webGLEnabled;
    const textCacheEnabled = settings.textCacheEnabled === undefined
        ? DEFAULT_PERSISTED_VIEW_SETTINGS.textCacheEnabled
        : settings.textCacheEnabled;
    const tiledRenderingEnabled = settings.tiledRenderingEnabled === undefined
        ? DEFAULT_PERSISTED_VIEW_SETTINGS.tiledRenderingEnabled
        : settings.tiledRenderingEnabled;
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
        !isPositiveFiniteNumber(drawZoomFactor) ||
        typeof webGLEnabled !== "boolean" ||
        typeof textCacheEnabled !== "boolean" ||
        typeof tiledRenderingEnabled !== "boolean") {
        return null;
    }
    return {
        theme: settings.theme,
        webGLEnabled,
        textCacheEnabled,
        tiledRenderingEnabled,
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

function formatConsoleArguments(values: readonly unknown[]): string {
    return values.map((value) => {
        if (value instanceof Error) {
            return value.stack ?? value.message;
        }
        if (typeof value === "string") {
            return value;
        }
        try {
            return JSON.stringify(value) ?? String(value);
        }
        catch {
            return String(value);
        }
    }).join(" ");
}

export function App() {
    const fileInputRef = useRef<HTMLInputElement>(null);
    const openControlsRef = useRef<HTMLDetailsElement>(null);
    const bookmarkControlsRef = useRef<HTMLDetailsElement>(null);
    const comparisonControlsRef = useRef<HTMLDetailsElement>(null);
    const viewControlsRef = useRef<HTMLDetailsElement>(null);
    const traceSheetRef = useRef<TraceSheetHandle>(null);
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
    const logEntryIDRef = useRef(0);
    const logPaneOpenRef = useRef(false);

    const {
        tabs,
        activeTabID,
        settings,
        recentFiles,
        changedFileTabIDs,
        reloadableTabIDs,
        fileMessage,
    } = useSyncExternalStore(store.subscribe, store.getSnapshot);
    const [isDraggingFile, setIsDraggingFile] = useState(false);
    const [statsProgress, setStatsProgress] = useState<number | null>(null);
    const [statsValues, setStatsValues] = useState<Readonly<StatsValues> | null>(null);
    const [statsError, setStatsError] = useState("");
    const [isStatsDialogOpen, setIsStatsDialogOpen] = useState(false);
    const [isCustomColorDialogOpen, setIsCustomColorDialogOpen] = useState(false);
    const [comparisonCandidateID, setComparisonCandidateID] = useState<number | null>(null);
    const [commandPaletteInitial, setCommandPaletteInitial] = useState<string | null>(null);
    const [commandMessage, setCommandMessage] = useState("");
    const [logEntries, setLogEntries] = useState<readonly LogEntry[]>([]);
    const [unreadLogCount, setUnreadLogCount] = useState(0);
    const [hasUnreadWarning, setHasUnreadWarning] = useState(false);
    const [isLogPaneOpen, setIsLogPaneOpen] = useState(false);
    // 旧版と同じ10枠だけを読み込み、設定全体を扱う新しい層は設けない。
    const [bookmarks, setBookmarks] = useState<readonly ViewBookmark[]>(loadBookmarks);
    // CanvasはReact DOMを持たないため、Storeの明示的な内容更新を再描画へ結び付ける番号を持つ。
    const [renderVersion, setRenderVersion] = useState(0);

    const activeTab = store.activeTab;
    const comparisonTab = activeTab?.kind === "comparison" ? activeTab : null;
    const comparisonCandidates = tabs.filter((tab) =>
        tab.kind === "trace" && tab.loadState === "ready" && tab.trace !== null && tab.id !== activeTab?.id);
    const selectedComparisonCandidateID = comparisonCandidates.some((tab) => tab.id === comparisonCandidateID)
        ? comparisonCandidateID
        : comparisonCandidates[0]?.id ?? null;
    const trace = activeTab?.trace ?? null;
    const loadState = activeTab?.loadState ?? "idle";
    const fileName = activeTab?.fileName ?? "";
    const progress = activeTab?.progress ?? 0;
    const errorMessage = activeTab?.errorMessage ?? "";
    const renderSpec = activeTab?.renderSpec ?? DEFAULT_KONATA_RENDER_SPEC;
    const searchProgress = activeTab?.findContext.progress ?? null;
    const findResult = activeTab?.findContext.result ?? null;
    const searchMessage = activeTab?.findContext.message ?? "";

    useEffect(() => {
        const originalLog = console.log;
        const originalInfo = console.info;
        const originalWarn = console.warn;
        const originalError = console.error;
        const capture = (
            level: LogLevel,
            output: (...values: unknown[]) => void,
        ) => (...values: unknown[]) => {
            Reflect.apply(output, console, values);
            const entry: LogEntry = {
                id: logEntryIDRef.current++,
                level,
                message: formatConsoleArguments(values),
            };
            setLogEntries((previous) => [
                ...previous.slice(Math.max(0, previous.length - MAX_LOG_ENTRIES + 1)),
                entry,
            ]);
            if (!logPaneOpenRef.current) {
                setUnreadLogCount((count) => count + 1);
                if (level !== "info") {
                    setHasUnreadWarning(true);
                }
            }
        };
        const log = capture("info", originalLog);
        const info = capture("info", originalInfo);
        const warn = capture("warning", originalWarn);
        const error = capture("error", originalError);
        console.log = log;
        console.info = info;
        console.warn = warn;
        console.error = error;
        return () => {
            // 別のコードが後からconsoleを差し替えた場合は、その変更をcleanupで上書きしない。
            if (console.log === log) console.log = originalLog;
            if (console.info === info) console.info = originalInfo;
            if (console.warn === warn) console.warn = originalWarn;
            if (console.error === error) console.error = originalError;
        };
    }, []);

    useEffect(() => {
        saveBookmarks(bookmarks);
    }, [bookmarks]);

    useEffect(() => {
        store.dispatch({ type: "FILE_RECENT_LOAD_REQUEST" });
    }, [store]);

    useEffect(() => {
        if (trace === null) {
            bookmarkControlsRef.current?.removeAttribute("open");
        }
    }, [trace]);

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
        store.dispatch({ type: "FILE_MESSAGE_DISMISS" });
    }, [store]);

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
        apply: (progress: number) => void,
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
            // Tab切替後に、以前の表示状態を画面外で更新し続けない。
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
            animation.apply(progress);
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

    const closeTab = useCallback((id: number) => {
        const wasActive = store.activeTab?.id === id;
        if (wasActive) {
            cancelViewAnimation();
            // 比較描画では同じCanvasへ2つのtraceを続けて描くため、どちらのStoreも
            // 解放する前にCanvas側の遅延描画資源を明示的に破棄する。
            traceSheetRef.current?.resetPipelineCanvas();
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
        if (change.type === "FILE_INPUT_REQUEST") {
            fileInputRef.current?.click();
        }
        if (change.type === "COMMAND_MESSAGE_UPDATE") {
            setCommandMessage(change.message);
        }
        if (change.type === "PROGRESS_BAR_START" && change.operation === "load") {
            cancelViewAnimation();
            resetStats();
            resetCommandUI();
        }
    }), [cancelViewAnimation, resetCommandUI, resetStats, store]);

    useEffect(() => () => {
        statsRequestRef.current++;
        cancelViewAnimation();
        // StrictModeの初回cleanup時点ではtabがなく、実際のunmountではStoreが全tabを閉じる。
        store.dispatch({ type: "STORE_CLOSE" });
    }, [cancelViewAnimation, store]);

    useEffect(() => {
        const fileNames = getRemoteTraceFileNames(window.location.hash);
        if (fileNames.length === 0) {
            return;
        }
        // StrictModeの再mountでは最初のopen要求を止め、同じremote traceを二重に開かない。
        const abortController = new AbortController();
        store.dispatch({
            type: "FILE_REMOTE_OPEN_REQUEST",
            fileNames,
            pageURL: window.location.href,
            signal: abortController.signal,
        });
        return () => abortController.abort();
    }, [store]);

    const openFilePicker = useCallback(() => {
        openControlsRef.current?.removeAttribute("open");
        store.dispatch({ type: "FILE_PICK_REQUEST" });
    }, [store]);

    const openRecentFile = useCallback((id: string) => {
        openControlsRef.current?.removeAttribute("open");
        store.dispatch({ type: "FILE_RECENT_OPEN_REQUEST", id });
    }, [store]);

    const reloadTab = useCallback((tabID: number) => {
        openControlsRef.current?.removeAttribute("open");
        store.dispatch({ type: "FILE_RELOAD_REQUEST", tabID });
    }, [store]);

    const dismissFileChange = useCallback((tabID: number) => {
        store.dispatch({ type: "FILE_CHANGE_DISMISS", tabID });
    }, [store]);

    const handleFileInput = (event: ChangeEvent<HTMLInputElement>) => {
        const files = Array.from(event.target.files ?? []);
        if (files.length > 0) {
            store.dispatch({ type: "FILE_OPEN_REQUEST", files });
        }
        // 同じファイルを再選択してもchangeが発火するようvalueを戻す。
        event.target.value = "";
    };

    const handleDrop = (event: DragEvent<HTMLElement>) => {
        event.preventDefault();
        setIsDraggingFile(false);
        const files = Array.from(event.dataTransfer.files);
        if (files.length > 0) {
            store.dispatch({ type: "FILE_OPEN_REQUEST", files });
        }
    };

    const panView = useCallback((deltaX: number, deltaY: number) => {
        // drag、pinchなど入力自体が連続する操作は、途中の値を起点に即座に引き継ぐ。
        cancelViewAnimation();
        traceSheetRef.current?.clearToolTip();
        const tab = store.activeTab;
        if (tab === null) {
            return;
        }
        store.dispatch({
            type: "KONATA_PAN_VIEW",
            tabID: tab.id,
            deltaX,
            deltaY,
            target: "selected",
        });
    }, [cancelViewAnimation, store]);

    const pinchView = useCallback((
        panDeltaX: number,
        panDeltaY: number,
        zoomLevelDifference: number,
        centerX: number,
        centerY: number,
    ) => {
        cancelViewAnimation();
        traceSheetRef.current?.clearToolTip();
        const tab = store.activeTab;
        if (tab === null) {
            return;
        }
        store.dispatch({
            type: "KONATA_PINCH_VIEW",
            tabID: tab.id,
            panDeltaX,
            panDeltaY,
            zoomLevelDifference,
            centerX,
            centerY,
        });
    }, [cancelViewAnimation, store]);

    const scrollTo = useCallback((
        position: readonly [number, number],
        baselinePosition?: readonly [number, number],
    ) => {
        const tab = store.activeTab;
        if (tab === null) {
            return;
        }
        const [fromX, fromY] = tab.renderSpec.position;
        const baselineSpec = tab.kind === "comparison" ? tab.baselineRenderSpec : null;
        const [baselineFromX, baselineFromY] = baselineSpec?.position ?? [0, 0];
        const baselineSelected = tab.kind === "comparison" && tab.mode === "baseline";
        // positionは現在の主表示の絶対座標として受け取る。OverlayではBを基準にし、
        // Aには同じ論理座標差を加えることで、手動で作ったずれを維持する。
        const [toX, toY] = baselineSelected ? [fromX, fromY] : position;
        const [baselineToX, baselineToY] = baselinePosition ?? (baselineSelected
            ? position
            : [
                baselineFromX + toX - fromX,
                baselineFromY + toY - fromY,
            ]);
        const applyCandidate = tab.kind !== "comparison" || tab.mode !== "baseline";
        const applyBaseline = tab.kind === "comparison" && tab.mode !== "candidate";
        startViewAnimation(SCROLL_ANIMATION_DURATION, (progress) => {
            const candidatePosition: readonly [number, number] = [
                fromX + (toX - fromX) * progress,
                fromY + (toY - fromY) * progress,
            ];
            const nextBaselinePosition: readonly [number, number] = [
                baselineFromX + (baselineToX - baselineFromX) * progress,
                baselineFromY + (baselineToY - baselineFromY) * progress,
            ];
            store.dispatch({
                type: "KONATA_SET_VIEW",
                tabID: tab.id,
                view: applyCandidate ? {
                    position: candidatePosition,
                    zoomLevel: tab.renderSpec.zoomLevel,
                } : undefined,
                baselineView: applyBaseline && baselineSpec !== null ? {
                    position: nextBaselinePosition,
                    zoomLevel: baselineSpec.zoomLevel,
                } : undefined,
            });
        });
    }, [startViewAnimation, store]);

    useEffect(() => store.subscribeChange((change) => {
        if (change.type === "VIEW_SCROLL_REQUEST" && store.activeTab?.id === change.tabID) {
            scrollTo(change.position, change.baselinePosition);
            if (change.accumulate && change.candidatePosition !== undefined) {
                pendingScrollRef.current = {
                    tabID: change.tabID,
                    position: change.candidatePosition,
                    baselinePosition: change.baselinePosition,
                };
            }
        }
    }), [scrollTo, store]);

    const moveView = useCallback((
        difference: readonly [number, number],
        adjustHorizontal: boolean,
    ) => {
        const tab = store.activeTab;
        if (tab === null) {
            return;
        }
        const pending = pendingScrollRef.current;
        store.dispatch({
            type: "KONATA_MOVE_VIEW_REQUEST",
            tabID: tab.id,
            difference,
            adjustHorizontal,
            basePosition: pending?.tabID === tab.id ? pending.position : undefined,
            baselineBasePosition: pending?.tabID === tab.id ? pending.baselinePosition : undefined,
        });
    }, [store]);

    const adjustPosition = useCallback(() => {
        const tab = store.activeTab;
        if (tab !== null) {
            store.dispatch({ type: "KONATA_ADJUST_VIEW_REQUEST", tabID: tab.id });
        }
    }, [store]);

    const moveSplitter = useCallback((position: number) => {
        const tab = store.activeTab;
        if (tab !== null) {
            store.dispatch({ type: "PANE_SPLITTER_MOVE", tabID: tab.id, position });
        }
    }, [store]);

    const openComparison = useCallback(() => {
        const baseline = store.activeTab;
        if (baseline?.kind !== "trace" || selectedComparisonCandidateID === null) {
            return;
        }
        cancelViewAnimation();
        store.dispatch({
            type: "COMPARISON_OPEN",
            baselineTabID: baseline.id,
            candidateTabID: selectedComparisonCandidateID,
        });
        comparisonControlsRef.current?.removeAttribute("open");
        resetStats();
        resetCommandUI();
    }, [cancelViewAnimation, resetCommandUI, resetStats, selectedComparisonCandidateID, store]);

    const alignComparisonToBaseline = useCallback(() => {
        const tab = store.activeTab;
        if (tab?.kind !== "comparison") {
            return;
        }
        // 手動位置合わせ後は、次の入力から再び単純な同期scrollだけを行う。
        cancelViewAnimation();
        traceSheetRef.current?.clearToolTip();
        store.dispatch({ type: "COMPARISON_ALIGN_TO_BASELINE", tabID: tab.id });
    }, [cancelViewAnimation, store]);

    const openCommandPalette = useCallback((initialCommand: string) => {
        if (isStatsDialogOpen || isCustomColorDialogOpen) {
            return;
        }
        setCommandMessage("");
        setCommandPaletteInitial(initialCommand);
    }, [isCustomColorDialogOpen, isStatsDialogOpen]);

    const findString = useCallback((target: string, basePosition: number, reverse: boolean): void => {
        const searchedTab = store.activeTab;
        if (searchedTab === null || searchedTab.trace === null) {
            setCommandMessage("No trace is open.");
            return;
        }

        setCommandMessage("");
        store.dispatch({
            type: "KONATA_FIND_REQUEST",
            tabID: searchedTab.id,
            targetPattern: target,
            basePosition,
            reverse,
            // viewportは検索開始時の対象Tabの値を固定し、途中のTab切替と混同しない。
            viewport: traceSheetRef.current?.getViewportSize(),
        });
    }, [store]);

    const repeatSearch = useCallback((reverse: boolean) => {
        const tab = store.activeTab;
        if (tab === null || findResult === null) {
            return;
        }
        store.dispatch({
            type: "KONATA_FIND_REPEAT_REQUEST",
            tabID: tab.id,
            reverse,
            viewport: traceSheetRef.current?.getViewportSize(),
        });
    }, [findResult, store]);

    const executeCommand = useCallback((command: string) => {
        let accepted = false;
        const idMatch = command.match(/^j\s+(\d+)\s*$/);
        const ridMatch = command.match(/^jr\s+(\d+)\s*$/);
        const findMatch = command.match(/^f\s+(.+)$/);

        if (idMatch !== null) {
            hideSearchResult();
            store.dispatch({
                type: "KONATA_JUMP_REQUEST",
                tabID: store.activeTab?.id ?? -1,
                target: "id",
                value: Number(idMatch[1]),
            });
            accepted = true;
        }
        else if (ridMatch !== null) {
            hideSearchResult();
            store.dispatch({
                type: "KONATA_JUMP_REQUEST",
                tabID: store.activeTab?.id ?? -1,
                target: "rid",
                value: Number(ridMatch[1]),
            });
            accepted = true;
        }
        else if (findMatch !== null) {
            findString(
                findMatch[1],
                Math.floor(store.activeTab?.renderSpec.position[1] ?? 0),
                false,
            );
            accepted = true;
        }
        else if (/^l(?:\s+.*)?$/.test(command)) {
            // Webではpathを直接開けないため、lは同じfile pickerを起動する。
            void openFilePicker();
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
    }, [commandHistory, findString, hideSearchResult, openFilePicker, store]);

    const zoomAt = useCallback((factor: number, centerX: number, centerY: number) => {
        const tab = store.activeTab;
        if (tab === null || factor === 1) {
            return;
        }
        const fromLevel = tab.renderSpec.zoomLevel;
        const pending = pendingZoomRef.current;
        // wheelなどが次のframeより速く届いても、各1段分を失わず目標倍率へ積み上げる。
        const baseLevel = pending?.tabID === tab.id ? pending.level : fromLevel;
        // 旧drawZoomFactorと同じく、値を大きくすると1操作あたりの倍率変化を細かくする。
        const zoomStep = 1 / settings.drawZoomFactor;
        const toLevel = clampKonataZoomLevel(baseLevel + (factor > 1 ? -zoomStep : zoomStep));
        startViewAnimation(ZOOM_ANIMATION_DURATION, (progress) => {
            store.dispatch({
                type: "KONATA_SET_ZOOM",
                tabID: tab.id,
                zoomLevel: fromLevel + (toLevel - fromLevel) * progress,
                centerX,
                centerY,
                target: "both",
            });
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
        const zoomScale = getKonataZoomScale(store.activeTab?.renderSpec.zoomLevel ?? 0);
        const differenceY = delta * 3 / zoomScale;
        moveView([0, differenceY], adjust);
    }, [moveView, store]);

    const moveHorizontal = useCallback((delta: number) => {
        const zoomScale = getKonataZoomScale(store.activeTab?.renderSpec.zoomLevel ?? 0);
        const differenceX = delta * 6 / zoomScale;
        moveView([differenceX, 0], false);
    }, [moveView, store]);

    const setBookmark = useCallback((index: number) => {
        const spec = store.activeTab?.renderSpec ?? DEFAULT_KONATA_RENDER_SPEC;
        const [x, y] = spec.position;
        // 旧Configの保存値と同じく、論理座標は整数へ切り下げる。
        const bookmark = { x: Math.floor(x), y: Math.floor(y), zoom: spec.zoomLevel };
        setBookmarks((current) => current.map((value, position) =>
            position === index ? bookmark : value));
    }, [store]);

    const goToBookmark = useCallback((index: number) => {
        const bookmark = bookmarks[index];
        if (bookmark === undefined) {
            return;
        }
        const tab = store.activeTab;
        if (tab === null) {
            return;
        }
        const [fromX, fromY] = tab.renderSpec.position;
        const fromZoom = tab.renderSpec.zoomLevel;
        const baselineSpec = tab.kind === "comparison" ? tab.baselineRenderSpec : null;
        const [baselineFromX, baselineFromY] = baselineSpec?.position ?? [0, 0];
        const differenceX = bookmark.x - fromX;
        const differenceY = bookmark.y - fromY;
        startViewAnimation(BOOKMARK_ANIMATION_DURATION, (progress) => {
            // 旧版同様にscrollとzoomを並行させ、bookmark座標をずらす補正は行わない。
            const zoomProgress = Math.min(
                1,
                progress * BOOKMARK_ANIMATION_DURATION / BOOKMARK_ZOOM_ANIMATION_DURATION,
            );
            const zoomLevel = fromZoom + (bookmark.zoom - fromZoom) * zoomProgress;
            store.dispatch({
                type: "KONATA_SET_VIEW",
                tabID: tab.id,
                view: {
                    zoomLevel,
                    position: [
                        fromX + (bookmark.x - fromX) * progress,
                        fromY + (bookmark.y - fromY) * progress,
                    ],
                },
                baselineView: baselineSpec === null ? undefined : {
                    zoomLevel,
                    position: [
                        baselineFromX + differenceX * progress,
                        baselineFromY + differenceY * progress,
                    ],
                },
            });
        });
    }, [bookmarks, startViewAnimation, store]);

    const resetView = useCallback(() => {
        const tab = store.activeTab;
        if (tab === null) {
            return;
        }
        const [fromX, fromY] = tab.renderSpec.position;
        const fromZoom = tab.renderSpec.zoomLevel;
        const baselineSpec = tab.kind === "comparison" ? tab.baselineRenderSpec : null;
        const [baselineFromX, baselineFromY] = baselineSpec?.position ?? [0, 0];
        startViewAnimation(BOOKMARK_ANIMATION_DURATION, (progress) => {
            const zoomLevel = fromZoom * (1 - progress);
            store.dispatch({
                type: "KONATA_SET_VIEW",
                tabID: tab.id,
                view: {
                    zoomLevel,
                    position: [fromX * (1 - progress), fromY * (1 - progress)],
                },
                baselineView: baselineSpec === null ? undefined : {
                    zoomLevel,
                    // 旧sync scrollと同様、Candidateが原点へ戻る量だけ現在位置から動かす。
                    position: [
                        baselineFromX - fromX * progress,
                        baselineFromY - fromY * progress,
                    ],
                },
            });
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

    const openLogPane = () => {
        logPaneOpenRef.current = true;
        setIsLogPaneOpen(true);
        setUnreadLogCount(0);
        setHasUnreadWarning(false);
    };

    const closeLogPane = () => {
        logPaneOpenRef.current = false;
        setIsLogPaneOpen(false);
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
            if (commandPaletteInitial !== null) {
                return;
            }
            if (commandKey && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "o") {
                void openFilePicker();
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
        isStatsDialogOpen, moveHorizontal, moveVertical, openCommandPalette, openFilePicker,
        repeatSearch, setBookmark, trace, zoomAtCenter]);

    let statusMessage = "";
    let statusType: "loading" | "ready" | "warning" | "error" | "comparison" | "changed" | null = null;
    if (comparisonTab !== null) {
        statusMessage = `A: ${comparisonTab.baselineFileName} ↔ B: ${comparisonTab.candidateFileName}`;
        statusType = "comparison";
    }
    else if (loadState === "loading") {
        statusMessage = `Loading ${fileName}… ${Math.round(progress * 100)}%`;
        statusType = "loading";
    }
    else if (activeTab?.kind === "trace" && changedFileTabIDs.has(activeTab.id)) {
        statusMessage = `${fileName} changed on disk.`;
        statusType = "changed";
    }
    else if (loadState === "ready" && trace !== null) {
        const summary = `${trace.opCount.toLocaleString()} ops · ${trace.lastCycle.toLocaleString()} cycles · ${trace.laneNames.length.toLocaleString()} lanes`;
        if (trace.warningCount > 0) {
            const warningLabel = trace.warningCount === 1 ? "warning" : "warnings";
            statusMessage = `Loaded with ${trace.warningCount.toLocaleString()} ${warningLabel} · ${summary}`;
            statusType = "warning";
        }
        else {
            statusMessage = `Loaded · ${summary}`;
            statusType = "ready";
        }
    }
    else if (loadState === "error") {
        statusMessage = errorMessage;
        statusType = "error";
    }
    const visibleMessage = commandMessage !== ""
        ? commandMessage
        : fileMessage !== "" ? fileMessage : searchMessage;
    if (visibleMessage !== "") {
        statusMessage = visibleMessage;
        statusType = "error";
    }

    const operation = loadState === "loading"
        ? { type: "load", value: progress, label: `Loading ${fileName}` }
        : statsProgress !== null
            ? { type: "stats", value: statsProgress, label: "Calculating statistics" }
            : searchProgress !== null
                ? { type: "search", value: searchProgress, label: "Searching trace" }
                : null;
    const canReload = activeTab?.kind === "trace" &&
        activeTab.loadState !== "loading" && reloadableTabIDs.has(activeTab.id);

    return (
        <main
            className={`trace-app theme-${settings.theme}${isDraggingFile ? " is-dragging-file" : ""}`}
            data-theme={settings.theme}
            data-load-state={loadState}
            data-file-name={fileName}
            data-op-count={trace?.opCount ?? 0}
            data-lane-count={trace?.laneNames.length ?? 0}
            onClick={(event) => {
                // nativeのdetailsは外側clickで閉じないため、panel外だけを明示的に閉じる。
                for (const controls of [
                    openControlsRef.current,
                    bookmarkControlsRef.current,
                    comparisonControlsRef.current,
                    viewControlsRef.current,
                ]) {
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
                    accept=".log,.txt,.gz,.zst,.zstd,text/plain,application/gzip,application/zstd"
                    onChange={handleFileInput}
                />
                <details ref={openControlsRef} className="open-controls">
                    <summary
                        className="primary-button toolbar-action"
                        aria-label="Open files"
                        title="Open files"
                        onClick={() => {
                            bookmarkControlsRef.current?.removeAttribute("open");
                            comparisonControlsRef.current?.removeAttribute("open");
                            viewControlsRef.current?.removeAttribute("open");
                        }}
                    >
                        <BsFolder2Open aria-hidden="true" />
                        <span>Open</span>
                    </summary>
                    <div className="open-controls-panel">
                        <button type="button" onClick={openFilePicker}>
                            <BsFolder2Open aria-hidden="true" />
                            <span>Open file…</span>
                        </button>
                        <button
                            type="button"
                            disabled={!canReload}
                            onClick={() => activeTab !== null && reloadTab(activeTab.id)}
                        >
                            <BsArrowClockwise aria-hidden="true" />
                            <span>Reload current</span>
                        </button>
                        <p>Recent files</p>
                        {recentFiles.length === 0 ? (
                            <span className="recent-files-empty">No recent files</span>
                        ) : recentFiles.map((record) => (
                            <button
                                className="recent-file"
                                type="button"
                                title={record.name}
                                key={record.id}
                                onClick={() => openRecentFile(record.id)}
                            >
                                <BsClockHistory aria-hidden="true" />
                                <span>{record.name}</span>
                            </button>
                        ))}
                    </div>
                </details>
                <button
                    className="button-with-icon toolbar-action"
                    type="button"
                    aria-label="Search trace"
                    title="Search trace"
                    disabled={trace === null || loadState === "loading"}
                    onClick={() => commandPaletteInitial === null
                        ? openCommandPalette("f ")
                        : resetCommandUI()}
                >
                    <BsSearch aria-hidden="true" />
                    <span>Search</span>
                </button>
                <details ref={bookmarkControlsRef} className="bookmark-controls">
                    <summary
                        className="toolbar-action"
                        aria-label="Bookmarks"
                        aria-disabled={trace === null}
                        title="Bookmarks"
                        tabIndex={trace === null ? -1 : undefined}
                        onClick={(event) => {
                            if (trace === null) {
                                event.preventDefault();
                                return;
                            }
                            openControlsRef.current?.removeAttribute("open");
                            viewControlsRef.current?.removeAttribute("open");
                            comparisonControlsRef.current?.removeAttribute("open");
                        }}
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
                {comparisonTab === null ? (
                    <details ref={comparisonControlsRef} className="comparison-controls">
                        <summary
                            className="toolbar-action"
                            aria-label="Compare traces"
                            aria-disabled={activeTab?.kind !== "trace" || selectedComparisonCandidateID === null}
                            title="Compare traces"
                            tabIndex={activeTab?.kind !== "trace" || selectedComparisonCandidateID === null ? -1 : undefined}
                            onClick={(event) => {
                                if (activeTab?.kind !== "trace" || selectedComparisonCandidateID === null) {
                                    event.preventDefault();
                                    return;
                                }
                                openControlsRef.current?.removeAttribute("open");
                                bookmarkControlsRef.current?.removeAttribute("open");
                                viewControlsRef.current?.removeAttribute("open");
                            }}
                        >
                            <BsIntersect aria-hidden="true" />
                            <span>Compare</span>
                        </summary>
                        <div className="comparison-controls-panel">
                            <p
                                className="comparison-source-a"
                                title={activeTab?.fileName ?? ""}
                            >
                                A (current): {activeTab?.fileName ?? ""}
                            </p>
                            <label>
                                B
                                <select
                                    aria-label="Comparison candidate"
                                    value={selectedComparisonCandidateID ?? ""}
                                    onChange={(event) => setComparisonCandidateID(Number(event.target.value))}
                                >
                                    {comparisonCandidates.map((tab) => (
                                        <option key={tab.id} value={tab.id}>{tab.fileName}</option>
                                    ))}
                                </select>
                            </label>
                            <button type="button" onClick={openComparison}>Compare</button>
                        </div>
                    </details>
                ) : (
                    <div className="comparison-mode-controls" aria-label="Comparison display mode">
                        {([
                            ["baseline", "A"],
                            ["overlay", "Overlay"],
                            ["candidate", "B"],
                        ] as const).map(([mode, label]) => (
                            <button
                                type="button"
                                className={`comparison-mode-button comparison-mode-${mode}${
                                    comparisonTab.mode === mode ? " is-active" : ""}`}
                                aria-pressed={comparisonTab.mode === mode}
                                title={mode === "baseline"
                                    ? comparisonTab.baselineFileName
                                    : mode === "candidate"
                                        ? comparisonTab.candidateFileName
                                        : label}
                                key={mode}
                                onClick={() => {
                                    cancelViewAnimation();
                                    store.dispatch({
                                        type: "COMPARISON_SET_MODE",
                                        tabID: comparisonTab.id,
                                        mode,
                                    });
                                }}
                            >
                                {label}
                            </button>
                        ))}
                        <button
                            type="button"
                            className="comparison-align-button"
                            aria-label="Align Candidate to A"
                            title="Adjust A, then align the Candidate to the retired instruction at the top of A."
                            onClick={alignComparisonToBaseline}
                        >
                            Align to A
                        </button>
                        {comparisonTab.mode === "overlay" && (
                            <label title="Change the opacity of the Candidate trace.">
                                Opacity
                                <input
                                    type="range"
                                    aria-label="Comparison opacity"
                                    min="0"
                                    max="1"
                                    step="0.05"
                                    value={comparisonTab.opacity}
                                    onChange={(event) => store.dispatch({
                                        type: "COMPARISON_SET_OPACITY",
                                        tabID: comparisonTab.id,
                                        opacity: Number(event.target.value),
                                    })}
                                />
                            </label>
                        )}
                    </div>
                )}
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
                        onClick={() => {
                            openControlsRef.current?.removeAttribute("open");
                            bookmarkControlsRef.current?.removeAttribute("open");
                            comparisonControlsRef.current?.removeAttribute("open");
                        }}
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
                                checked={renderSpec.hideFlushedOps}
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
                            <label title={comparisonTab === null
                                ? "Choose how pipeline stages are colored."
                                : "Comparison colors are fixed so A and B remain distinguishable."}>
                                Color
                                <select
                                    aria-label="Pipeline color scheme"
                                    value={comparisonTab === null ? renderSpec.colorScheme : "Comparison"}
                                    disabled={trace === null || comparisonTab !== null}
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
                                    {comparisonTab !== null && <option>Comparison</option>}
                                    <option>Auto</option>
                                    <option>Unique</option>
                                    <option>ThreadID</option>
                                    <option>Orange</option>
                                    <option>RoyalBlue</option>
                                    <option>Custom</option>
                                </select>
                            </label>
                            {comparisonTab === null && renderSpec.colorScheme === "Custom" && (
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
                        <details className="compatibility-settings">
                            <summary title="Rendering options for compatibility and troubleshooting.">
                                Compatibility
                            </summary>
                            <label title="Disable WebGL if rendering problems occur.">
                                <input
                                    type="checkbox"
                                    aria-label="WebGL rendering"
                                    checked={settings.webGLEnabled}
                                    onChange={(event) => store.dispatch({
                                        type: "KONATA_SET_WEBGL_ENABLED",
                                        enabled: event.target.checked,
                                    })}
                                />
                                WebGL rendering
                            </label>
                            <label title="Disable if cached text appears blurred or otherwise incorrect.">
                                <input
                                    type="checkbox"
                                    aria-label="Text caching"
                                    checked={settings.textCacheEnabled}
                                    onChange={(event) => store.dispatch({
                                        type: "KONATA_SET_TEXT_CACHE_ENABLED",
                                        enabled: event.target.checked,
                                    })}
                                />
                                Text caching
                            </label>
                            <label title="Disable tiled rendering if scrolling or zooming displays stale or incomplete regions.">
                                <input
                                    type="checkbox"
                                    aria-label="Tiled rendering"
                                    checked={settings.tiledRenderingEnabled}
                                    onChange={(event) => store.dispatch({
                                        type: "KONATA_SET_TILED_RENDERING_ENABLED",
                                        enabled: event.target.checked,
                                    })}
                                />
                                Tiled rendering
                            </label>
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
                    <output>{formatKonataZoomPercent(renderSpec.zoomLevel)}</output>
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
                {statusType === null ? (
                    <span className="status-spacer" aria-hidden="true" />
                ) : (
                    <p
                        className={`status status-${statusType}`}
                        role={statusType === "error" ? "alert" : "status"}
                        title={statusMessage}
                    >
                        {(statusType === "loading" || statusType === "ready") && (
                            <span className="status-loading-dots" aria-hidden="true">
                                {Array.from({length: 6}, (_, index) => <span key={index} />)}
                            </span>
                        )}
                        {(statusType === "warning" || statusType === "error") && (
                            <BsExclamationTriangleFill aria-hidden="true" />
                        )}
                        <span className="status-message">{statusMessage}</span>
                        {statusType === "changed" && activeTab !== null && (
                            <span className="status-actions">
                                <button type="button" onClick={() => reloadTab(activeTab.id)}>Reload</button>
                                <button type="button" onClick={() => dismissFileChange(activeTab.id)}>Ignore</button>
                            </span>
                        )}
                    </p>
                )}
                <ApplicationMenu
                    unreadLogCount={unreadLogCount}
                    hasUnreadWarning={hasUnreadWarning}
                    onOpenLog={openLogPane}
                />
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
                trace={trace}
                renderSpec={renderSpec}
                loadState={loadState}
                errorMessage={errorMessage}
                renderVersion={renderVersion}
                webGLEnabled={settings.webGLEnabled}
                textCacheEnabled={settings.textCacheEnabled}
                tiledRenderingEnabled={settings.tiledRenderingEnabled}
                findResult={findResult}
                comparison={comparisonTab === null ? null : {
                    baselineTrace: comparisonTab.baselineTrace,
                    baselineRenderSpec: comparisonTab.baselineRenderSpec,
                    mode: comparisonTab.mode,
                    opacity: comparisonTab.opacity,
                }}
                splitterPosition={activeTab?.splitterPosition ?? DEFAULT_SPLITTER_POSITION}
                onMoveSplitter={moveSplitter}
                onPanView={panView}
                onPinchView={pinchView}
                onMoveView={moveView}
                onScrollView={scrollTo}
                onZoomView={zoomAt}
                onCloseFindResult={hideSearchResult}
                onOpenTrace={openFilePicker}
            />
            {isLogPaneOpen && (
                <LogPane
                    entries={logEntries}
                    onClear={() => {
                        setLogEntries([]);
                        setUnreadLogCount(0);
                        setHasUnreadWarning(false);
                    }}
                    onClose={closeLogPane}
                />
            )}
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
