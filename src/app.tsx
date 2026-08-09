import { type ChangeEvent, type DragEvent, useCallback, useEffect, useRef, useState } from "react";

import { CommandPalette } from "./components/command_palette";
import { StatsDialog } from "./components/stats_dialog";
import { TabBar } from "./components/tab_bar";
import {
    type FindResult,
    type LoadState,
    TraceSheet,
    type TraceSheetHandle,
} from "./components/trace_sheet";
import type { Op, ParsedTrace } from "./core/model";
import { Gem5O3PipeViewParser } from "./core/gem5_o3_pipe_view_parser";
import { OnikiriParser } from "./core/onikiri_parser";
import { calculateStats, type StatsValues } from "./core/stats";
import {
    DEP_ARROW_TYPE,
    KonataRenderer,
    type DependencyArrowType,
    type RendererTheme,
} from "./renderer/konata_renderer";

type DrawingThreshold =
    | "drawTextThreshold"
    | "drawDetailedlyThreshold"
    | "drawDependencyThreshold"
    | "drawFrameThreshold";

interface ViewBookmark {
    readonly x: number;
    readonly y: number;
    readonly zoom: number;
}

interface TraceTab {
    readonly id: number;
    readonly fileName: string;
    readonly renderer: KonataRenderer;
    trace: ParsedTrace | null;
    loadState: LoadState;
    progress: number;
    errorMessage: string;
}

function closeTabTrace(tab: TraceTab): void {
    const trace = tab.trace;
    tab.trace = null;
    // Renderer側の参照も先に外し、閉じたtabだけでtrace全体を回収できるようにする。
    tab.renderer.setTrace(null);
    trace?.close();
}

// 旧Settings dialogで変更できた描画閾値だけを、既存View panelへそのまま並べる。
const DRAWING_THRESHOLDS: ReadonlyArray<readonly [DrawingThreshold, string]> = [
    ["drawTextThreshold", "Text"],
    ["drawDetailedlyThreshold", "Stage colors"],
    ["drawDependencyThreshold", "Dependency arrows"],
    ["drawFrameThreshold", "Frames"],
];

function createTabRenderer(source: KonataRenderer): KonataRenderer {
    const renderer = new KonataRenderer();
    // 単一sheet版で新しいfileを開いた時と同じく、現在の表示設定を次のtabへ引き継ぐ。
    renderer.setTheme(source.theme);
    renderer.hideFlushedOps = source.hideFlushedOps;
    renderer.splitLanes = source.splitLanes;
    renderer.fixOpHeight = source.fixOpHeight;
    renderer.changeColorScheme(source.colorScheme);
    renderer.dependencyArrowType = source.dependencyArrowType;
    for (const [key] of DRAWING_THRESHOLDS) {
        renderer[key] = source[key];
    }
    return renderer;
}

const INITIAL_BOOKMARKS: readonly ViewBookmark[] = Array.from(
    { length: 10 },
    () => ({ x: 0, y: 0, zoom: 0 }),
);
const BOOKMARK_STORAGE_KEY = "konata.bookmarks";

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
    const traceSheetRef = useRef<TraceSheetHandle>(null);
    const emptyRendererRef = useRef(new KonataRenderer());
    const tabsRef = useRef(new Map<number, TraceTab>());
    const activeTabRef = useRef<TraceTab | null>(null);
    const nextTabIDRef = useRef(0);
    const statsRequestRef = useRef(0);
    const searchRequestRef = useRef(0);
    const commandHistoryRef = useRef<string[]>([]);

    const [tabs, setTabs] = useState<readonly TraceTab[]>([]);
    const [activeTabID, setActiveTabID] = useState<number | null>(null);
    const [isDraggingFile, setIsDraggingFile] = useState(false);
    const [statsProgress, setStatsProgress] = useState<number | null>(null);
    const [statsValues, setStatsValues] = useState<Readonly<StatsValues> | null>(null);
    const [statsError, setStatsError] = useState("");
    const [isStatsDialogOpen, setIsStatsDialogOpen] = useState(false);
    const [commandPaletteInitial, setCommandPaletteInitial] = useState<string | null>(null);
    const [commandMessage, setCommandMessage] = useState("");
    const [searchProgress, setSearchProgress] = useState<number | null>(null);
    const [findResult, setFindResult] = useState<FindResult | null>(null);
    // 旧版と同じ10枠だけを読み込み、設定全体を扱う新しい層は設けない。
    const [bookmarks, setBookmarks] = useState<readonly ViewBookmark[]>(loadBookmarks);
    // CanvasはReact DOMを持たないため、Rendererのview変更を再描画へ結び付ける番号を持つ。
    const [renderVersion, setRenderVersion] = useState(0);

    const activeTab = tabs.find((tab) => tab.id === activeTabID) ?? null;
    activeTabRef.current = activeTab;
    const trace = activeTab?.trace ?? null;
    const loadState = activeTab?.loadState ?? "idle";
    const fileName = activeTab?.fileName ?? "";
    const progress = activeTab?.progress ?? 0;
    const errorMessage = activeTab?.errorMessage ?? "";
    const renderer = activeTab?.renderer ?? emptyRendererRef.current;

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

    const resetSearch = useCallback(() => {
        searchRequestRef.current++;
        setSearchProgress(null);
        setFindResult(null);
        setCommandMessage("");
        setCommandPaletteInitial(null);
    }, []);

    const publishTabs = useCallback(() => {
        setTabs(Array.from(tabsRef.current.values()));
    }, []);

    const activateTab = useCallback((id: number) => {
        if (!tabsRef.current.has(id) || activeTabRef.current?.id === id) {
            return;
        }
        // 検索結果とdialogはactive sheetだけに属し、tabをまたいで表示しない。
        resetStats();
        resetSearch();
        setActiveTabID(id);
        setRenderVersion((version) => version + 1);
    }, [resetSearch, resetStats]);

    const closeTab = useCallback((id: number) => {
        const openTabs = Array.from(tabsRef.current.values());
        const closingIndex = openTabs.findIndex((tab) => tab.id === id);
        const closingTab = openTabs[closingIndex];
        if (closingTab === undefined) {
            return;
        }

        // callbackが閉じたtabを更新しないよう、mapから外してからstoreを解放する。
        tabsRef.current.delete(id);
        closeTabTrace(closingTab);

        if (activeTabRef.current?.id === id) {
            resetStats();
            resetSearch();
            const remainingTabs = Array.from(tabsRef.current.values());
            const nextTab = remainingTabs[Math.min(closingIndex, remainingTabs.length - 1)] ?? null;
            setActiveTabID(nextTab?.id ?? null);
            setRenderVersion((version) => version + 1);
        }
        publishTabs();
    }, [publishTabs, resetSearch, resetStats]);

    useEffect(() => () => {
        statsRequestRef.current++;
        searchRequestRef.current++;
        // StrictModeの初回cleanup時点ではtabがなく、実際のunmountでは全storeを閉じる。
        for (const tab of tabsRef.current.values()) {
            closeTabTrace(tab);
        }
        tabsRef.current.clear();
        activeTabRef.current = null;
    }, []);

    const loadFile = useCallback(async (file: File) => {
        const sourceRenderer = activeTabRef.current?.renderer ?? emptyRendererRef.current;
        const tab: TraceTab = {
            id: nextTabIDRef.current++,
            fileName: file.name,
            renderer: createTabRenderer(sourceRenderer),
            trace: null,
            loadState: "loading",
            progress: 0,
            errorMessage: "",
        };
        tabsRef.current.set(tab.id, tab);
        publishTabs();
        resetStats();
        resetSearch();
        setActiveTabID(tab.id);
        setRenderVersion((version) => version + 1);

        try {
            const updateProgress = (value: number) => {
                if (tabsRef.current.get(tab.id) === tab) {
                    tab.progress = value;
                    publishTabs();
                }
            };
            const updateTrace = (partialTrace: ParsedTrace) => {
                if (tabsRef.current.get(tab.id) !== tab) {
                    return;
                }
                if (tab.trace !== partialTrace) {
                    // 形式確定時だけ同じstoreを持つtraceへ切り替え、以後は再描画だけを行う。
                    closeTabTrace(tab);
                    tab.trace = partialTrace;
                }
                publishTabs();
                setRenderVersion((version) => version + 1);
            };
            let parsedTrace: ParsedTrace;
            try {
                parsedTrace = await new OnikiriParser().parse(file, updateProgress, updateTrace);
            }
            catch (error) {
                // 現行版と同じ順序で試し、Kanataとして不正な入力だけをgem5へ渡す。
                if (!(error instanceof Error) || error.message !== "The selected file is not a Kanata trace.") {
                    throw error;
                }
                parsedTrace = await new Gem5O3PipeViewParser().parse(file, updateProgress, updateTrace);
            }
            if (tabsRef.current.get(tab.id) !== tab) {
                parsedTrace.close();
                return;
            }
            if (tab.trace !== parsedTrace) {
                closeTabTrace(tab);
                tab.trace = parsedTrace;
            }
            tab.progress = 1;
            tab.loadState = "ready";
            publishTabs();
            setRenderVersion((version) => version + 1);
        }
        catch (error) {
            if (tabsRef.current.get(tab.id) !== tab) {
                return;
            }
            closeTabTrace(tab);
            tab.loadState = "error";
            tab.errorMessage = error instanceof Error ? error.message : String(error);
            publishTabs();
            setRenderVersion((version) => version + 1);
        }
    }, [publishTabs, resetSearch, resetStats]);

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
        traceSheetRef.current?.clearToolTip();
        mutation(activeTabRef.current?.renderer ?? emptyRendererRef.current);
        setRenderVersion((version) => version + 1);
    }, []);

    const openCommandPalette = useCallback((initialCommand: string) => {
        if (isStatsDialogOpen) {
            return;
        }
        setCommandMessage("");
        setCommandPaletteInitial(initialCommand);
    }, [isStatsDialogOpen]);

    const findString = useCallback((target: string, basePosition: number, reverse: boolean): void => {
        let targetPattern: RegExp;
        try {
            targetPattern = new RegExp(target);
        }
        catch (error) {
            setCommandMessage(`"${target}" is an invalid regular expression. ${String(error)}`);
            return;
        }

        const searchedTab = activeTabRef.current;
        const activeTrace = searchedTab?.trace ?? null;
        if (searchedTab === null || activeTrace === null) {
            setCommandMessage("No trace is open.");
            return;
        }

        const requestID = ++searchRequestRef.current;
        setSearchProgress(0);
        setFindResult(null);
        setCommandMessage("");

        void (async () => {
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

                const op = activeTrace.getOp(current);
                if (op !== undefined && targetPattern.test(makeFindTargetString(op))) {
                    foundOp = op;
                    break;
                }

                // 大きなtraceでもUI操作で新しい検索へ切り替えられるよう、旧版と同じ間隔でyieldする。
                if (index % sleepPeriod === 0 && previousSleepTime + 100 < Date.now()) {
                    previousSleepTime = Date.now();
                    if (searchRequestRef.current === requestID) {
                        setSearchProgress(lastOpID > 0 ? index / lastOpID : 1);
                    }
                    await new Promise((resolve) => setTimeout(resolve, 17));
                    if (searchRequestRef.current !== requestID || activeTabRef.current !== searchedTab) {
                        return;
                    }
                }
            }

            console.log(`Search finished: ${target}@${foundOp?.id ?? -1}, ${Date.now() - startTime} msec`);
            if (searchRequestRef.current !== requestID || activeTabRef.current !== searchedTab) {
                return;
            }
            setSearchProgress(null);

            if (foundOp === undefined) {
                setCommandMessage(`"${target}" was not found.`);
                return;
            }

            const renderer = searchedTab.renderer;
            const viewPosition = renderer.viewPosition;
            const moveTo = renderer.getPositionYFromOp(foundOp);
            let left = viewPosition[0];
            let top = viewPosition[1];
            const viewport = traceSheetRef.current?.getViewportSize();
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
            mutateView((targetRenderer) => targetRenderer.moveLogicalPosition([left, top]));
            setFindResult({
                targetPattern: target,
                foundString: makeFindTargetString(foundOp),
                op: foundOp,
                anchorOp,
                flushed: foundOp.flush,
            });
        })().catch((error) => {
            if (searchRequestRef.current === requestID) {
                setSearchProgress(null);
                setCommandMessage(error instanceof Error ? error.message : String(error));
            }
        });
    }, [mutateView]);

    const repeatSearch = useCallback((reverse: boolean) => {
        if (findResult === null) {
            return;
        }
        const renderer = activeTabRef.current?.renderer ?? emptyRendererRef.current;
        const basePosition = renderer.getPositionYFromOp(findResult.anchorOp);
        findString(findResult.targetPattern, basePosition, reverse);
    }, [findResult, findString]);

    const executeCommand = useCallback((command: string) => {
        let accepted = false;
        const renderer = activeTabRef.current?.renderer ?? emptyRendererRef.current;
        const idMatch = command.match(/^j\s+(\d+)\s*$/);
        const ridMatch = command.match(/^jr\s+(\d+)\s*$/);
        const findMatch = command.match(/^f\s+(.+)$/);

        if (idMatch !== null) {
            resetSearch();
            const id = Number(idMatch[1]);
            const op = renderer.getVisibleOp(id);
            if (op === undefined) {
                setCommandMessage(`Op ${id} was not found.`);
            }
            else {
                mutateView((targetRenderer) => targetRenderer.moveLogicalPosition([op.fetchedCycle, id]));
            }
            accepted = true;
        }
        else if (ridMatch !== null) {
            resetSearch();
            const rid = Number(ridMatch[1]);
            const op = renderer.getOpFromRID(rid);
            const y = renderer.getPositionYFromRID(rid);
            if (op === undefined || y < 0) {
                setCommandMessage(`Retired op ${rid} was not found.`);
            }
            else {
                mutateView((targetRenderer) => targetRenderer.moveLogicalPosition([op.fetchedCycle, y]));
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
            commandHistoryRef.current.unshift(command);
            if (commandHistoryRef.current.length > 20) {
                commandHistoryRef.current.pop();
            }
        }
        setCommandPaletteInitial(null);
    }, [findString, mutateView, resetSearch]);

    const zoomAtCenter = useCallback((factor: number) => {
        const viewport = traceSheetRef.current?.getViewportSize();
        if (viewport === undefined) {
            return;
        }
        mutateView((renderer) => renderer.zoomAt(
            factor,
            viewport.pipelineWidth / 2,
            viewport.pipelineHeight / 2,
        ));
    }, [mutateView]);

    const moveVertical = useCallback((delta: number, adjust: boolean) => {
        const renderer = activeTabRef.current?.renderer ?? emptyRendererRef.current;
        const differenceY = delta * 3 / renderer.zoomScale;
        const differenceX = adjust ? renderer.adjustScrollDifferenceX(differenceY) : 0;
        mutateView((target) => target.moveLogicalDifference([differenceX, differenceY], false));
    }, [mutateView]);

    const moveHorizontal = useCallback((delta: number) => {
        mutateView((renderer) => renderer.moveLogicalDifference([
            delta * 6 / renderer.zoomScale,
            0,
        ], false));
    }, [mutateView]);

    const setBookmark = useCallback((index: number) => {
        const renderer = activeTabRef.current?.renderer ?? emptyRendererRef.current;
        const [x, y] = renderer.viewPosition;
        // 旧Configの保存値と同じく、論理座標は整数へ切り下げる。
        const bookmark = { x: Math.floor(x), y: Math.floor(y), zoom: renderer.zoomLevel };
        setBookmarks((current) => current.map((value, position) =>
            position === index ? bookmark : value));
    }, []);

    const goToBookmark = useCallback((index: number) => {
        const bookmark = bookmarks[index];
        if (bookmark === undefined) {
            return;
        }
        mutateView((renderer) => {
            // Web版はanimationを挟まず、旧版と同じ最終座標と倍率へ直接移動する。
            renderer.zoomAbs(bookmark.zoom, bookmark.x, bookmark.y, false);
            renderer.moveLogicalPosition([bookmark.x, bookmark.y]);
        });
    }, [bookmarks, mutateView]);

    const toggleHideFlushedOps = (enabled: boolean) => {
        mutateView((renderer) => {
            // 表示方式を変えても、現在の先頭命令とそのfetch位置を維持する。
            const current = renderer.getOpFromPixelPositionY(0);
            const rid = current?.rid ?? 0;
            renderer.hideFlushedOps = enabled;
            const op = renderer.getOpFromRID(rid);
            if (op !== undefined) {
                renderer.moveLogicalPosition([op.fetchedCycle, enabled ? rid : op.id]);
            }
        });
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
            () => statsRequestRef.current !== requestID || activeTabRef.current?.trace !== trace,
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
            if (isStatsDialogOpen) {
                if (event.key === "Escape") {
                    closeStatsDialog();
                    event.preventDefault();
                }
                return;
            }
            if (commandPaletteInitial !== null) {
                return;
            }

            const commandKey = event.ctrlKey || event.metaKey;
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
                searchRequestRef.current++;
                setSearchProgress(null);
                setFindResult(null);
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
    }, [commandPaletteInitial, goToBookmark, isStatsDialogOpen, moveHorizontal, moveVertical,
        openCommandPalette, repeatSearch, setBookmark, trace, zoomAtCenter]);

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
    if (commandMessage !== "") {
        statusMessage = commandMessage;
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
            className={`trace-app theme-${renderer.theme}${isDraggingFile ? " is-dragging-file" : ""}`}
            data-theme={renderer.theme}
            data-load-state={loadState}
            data-file-name={fileName}
            data-op-count={trace?.opCount ?? 0}
            data-lane-count={trace?.laneNames.size ?? 0}
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
                    history={commandHistoryRef.current}
                    onExecute={executeCommand}
                    onClose={() => setCommandPaletteInitial(null)}
                />
            )}
            <header className="app-toolbar">
                <input
                    ref={fileInputRef}
                    className="file-input"
                    type="file"
                    accept=".log,.txt,.gz,text/plain,application/gzip"
                    onChange={handleFileInput}
                />
                <button className="primary-button" type="button" onClick={() => fileInputRef.current?.click()}>
                    Open trace
                </button>
                <button
                    type="button"
                    disabled={trace === null || loadState === "loading" || statsProgress !== null || searchProgress !== null}
                    onClick={showStats}
                >
                    Stats
                </button>
                <div className="zoom-controls" aria-label="Zoom controls">
                    <button type="button" disabled={trace === null} onClick={() => zoomAtCenter(1 / 1.2)} aria-label="Zoom out">
                        −
                    </button>
                    <output>{renderer.zoomPercent}%</output>
                    <button type="button" disabled={trace === null} onClick={() => zoomAtCenter(1.2)} aria-label="Zoom in">
                        +
                    </button>
                    <button
                        type="button"
                        disabled={trace === null}
                        onClick={() => mutateView((renderer) => renderer.resetView())}
                    >
                        Reset
                    </button>
                </div>
                <details className="view-controls">
                    <summary>View</summary>
                    <div className="view-controls-panel">
                        <label>
                            Theme
                            <select
                                aria-label="UI color theme"
                                value={renderer.theme}
                                onChange={(event) => mutateView((renderer) => {
                                    renderer.setTheme(event.target.value as RendererTheme);
                                })}
                            >
                                <option value="dark">Dark</option>
                                <option value="light">Light</option>
                            </select>
                        </label>
                        <label>
                            <input
                                type="checkbox"
                                aria-label="Hide flushed ops"
                                checked={renderer.hideFlushedOps}
                                disabled={trace === null}
                                onChange={(event) => toggleHideFlushedOps(event.target.checked)}
                            />
                            Hide flushed ops
                        </label>
                        <label>
                            <input
                                type="checkbox"
                                aria-label="Split lanes"
                                checked={renderer.splitLanes}
                                disabled={trace === null}
                                onChange={(event) => mutateView((renderer) => {
                                    renderer.splitLanes = event.target.checked;
                                })}
                            />
                            Split lanes
                        </label>
                        <label>
                            <input
                                type="checkbox"
                                aria-label="Fix op height"
                                checked={renderer.fixOpHeight}
                                disabled={trace === null || !renderer.splitLanes}
                                onChange={(event) => mutateView((renderer) => {
                                    renderer.fixOpHeight = event.target.checked;
                                })}
                            />
                            Fix op height
                        </label>
                        <label>
                            Color
                            <select
                                aria-label="Pipeline color scheme"
                                value={renderer.colorScheme}
                                disabled={trace === null}
                                onChange={(event) => mutateView((renderer) => {
                                    renderer.changeColorScheme(event.target.value);
                                })}
                            >
                                <option>Auto</option>
                                <option>Unique</option>
                                <option>ThreadID</option>
                                <option>Orange</option>
                                <option>RoyalBlue</option>
                                <option>Custom</option>
                            </select>
                        </label>
                        <label>
                            Dependency arrows
                            <select
                                aria-label="Dependency arrow type"
                                value={renderer.dependencyArrowType}
                                disabled={trace === null}
                                onChange={(event) => mutateView((renderer) => {
                                    renderer.dependencyArrowType = event.target.value as DependencyArrowType;
                                })}
                            >
                                <option value={DEP_ARROW_TYPE.INSIDE_LINE}>Inside-line</option>
                                <option value={DEP_ARROW_TYPE.LEFT_SIDE_CURVE}>Leftside-curve</option>
                                <option value={DEP_ARROW_TYPE.NOT_SHOW}>Not show</option>
                            </select>
                        </label>
                        <details className="drawing-thresholds">
                            <summary>Drawing thresholds</summary>
                            {DRAWING_THRESHOLDS.map(([key, label]) => (
                                <label key={key}>
                                    {label}
                                    <input
                                        type="number"
                                        min="0"
                                        step="0.5"
                                        aria-label={`${label} drawing threshold`}
                                        value={renderer[key]}
                                        disabled={trace === null}
                                        onChange={(event) => {
                                            const value = Number(event.target.value);
                                            if (Number.isFinite(value) && value >= 0) {
                                                mutateView((renderer) => {
                                                    renderer[key] = value;
                                                });
                                            }
                                        }}
                                    />
                                </label>
                            ))}
                        </details>
                        <details className="bookmark-controls">
                            <summary>Bookmarks</summary>
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
                        </details>
                    </div>
                </details>
                <p className={`status ${commandMessage === "" ? `status-${loadState}` : "status-error"}`} role="status">
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

            <TabBar
                tabs={tabs}
                activeTabID={activeTabID}
                onActivate={activateTab}
                onClose={closeTab}
            />
            <TraceSheet
                key={activeTabID ?? "empty"}
                ref={traceSheetRef}
                renderer={renderer}
                trace={trace}
                loadState={loadState}
                renderVersion={renderVersion}
                findResult={findResult}
                onMutateView={mutateView}
                onCloseFindResult={() => setFindResult(null)}
            />
            {isStatsDialogOpen && (
                <StatsDialog values={statsValues} error={statsError} onClose={closeStatsDialog} />
            )}
        </main>
    );
}
