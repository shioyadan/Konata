import {
    type ChangeEvent,
    type DragEvent,
    type MouseEvent as ReactMouseEvent,
    type PointerEvent,
    type WheelEvent,
    useCallback,
    useEffect,
    useLayoutEffect,
    useRef,
    useState,
} from "react";

import type { Op, ParsedTrace } from "../core/model";
import { Gem5O3PipeViewParser } from "../core/gem5_o3_pipe_view_parser";
import { OnikiriParser } from "../core/onikiri_parser";
import { calculateStats, type StatsValues } from "../core/stats";
import {
    DEP_ARROW_TYPE,
    KonataRenderer,
    type DependencyArrowType,
    type RendererTheme,
} from "../renderer/konata_renderer";

type LoadState = "idle" | "loading" | "ready" | "error";

interface DragPosition {
    x: number;
    y: number;
}

interface CanvasToolTip {
    left: number;
    top: number;
    text: string;
}

interface FindResult {
    readonly targetPattern: string;
    readonly foundString: string;
    readonly op: Op;
    readonly anchorOp: Op;
    readonly flushed: boolean;
}

interface HighlightedText {
    readonly text: string;
    readonly matched: boolean;
}

type DrawingThreshold =
    | "drawTextThreshold"
    | "drawDetailedlyThreshold"
    | "drawDependencyThreshold"
    | "drawFrameThreshold";

// 旧Settings dialogで変更できた描画閾値だけを、既存View panelへそのまま並べる。
const DRAWING_THRESHOLDS: ReadonlyArray<readonly [DrawingThreshold, string]> = [
    ["drawTextThreshold", "Text"],
    ["drawDetailedlyThreshold", "Stage colors"],
    ["drawDependencyThreshold", "Dependency arrows"],
    ["drawFrameThreshold", "Frames"],
];

const COMMAND_HINTS: ReadonlyArray<readonly [string, string]> = [
    ["Jump to #line", "j  <#line>"],
    ["Jump to an op with rid", "jr <rid>"],
    ["Find a string ('F3' key finds next)", "f  <string>"],
    ["Load a file", "l"],
];

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

function highlightMatches(line: string, pattern: string): HighlightedText[] {
    const parts: HighlightedText[] = [];
    let position = 0;
    for (const match of line.matchAll(new RegExp(pattern, "g"))) {
        const matchPosition = match.index;
        const matchedText = match[0];
        // 空文字への一致には着色する文字がないが、matchAll自体は次へ進む。
        if (matchedText === "") {
            continue;
        }
        if (position < matchPosition) {
            parts.push({ text: line.slice(position, matchPosition), matched: false });
        }
        parts.push({ text: matchedText, matched: true });
        position = matchPosition + matchedText.length;
    }
    if (position < line.length || parts.length === 0) {
        parts.push({ text: line.slice(position), matched: false });
    }
    return parts;
}

export function TraceViewer() {
    const fileInputRef = useRef<HTMLInputElement>(null);
    const viewerRef = useRef<HTMLDivElement>(null);
    const labelCanvasRef = useRef<HTMLCanvasElement>(null);
    const pipelineCanvasRef = useRef<HTMLCanvasElement>(null);
    const commandInputRef = useRef<HTMLInputElement>(null);
    const rendererRef = useRef(new KonataRenderer());
    const traceRef = useRef<ParsedTrace | null>(null);
    // 複数ファイルが続けて選ばれた場合、遅く完了した旧requestで表示を上書きしない。
    const loadRequestRef = useRef(0);
    const statsRequestRef = useRef(0);
    const searchRequestRef = useRef(0);
    const commandHistoryRef = useRef<string[]>([]);
    const commandHistoryIndexRef = useRef(-1);
    const dragPositionRef = useRef<DragPosition | null>(null);

    const [trace, setTrace] = useState<ParsedTrace | null>(null);
    const [loadState, setLoadState] = useState<LoadState>("idle");
    const [fileName, setFileName] = useState("");
    const [progress, setProgress] = useState(0);
    const [errorMessage, setErrorMessage] = useState("");
    const [isDraggingFile, setIsDraggingFile] = useState(false);
    const [isPanning, setIsPanning] = useState(false);
    const [toolTip, setToolTip] = useState<CanvasToolTip | null>(null);
    const [statsProgress, setStatsProgress] = useState<number | null>(null);
    const [statsValues, setStatsValues] = useState<Readonly<StatsValues> | null>(null);
    const [statsFilter, setStatsFilter] = useState("");
    const [statsError, setStatsError] = useState("");
    const [isStatsDialogOpen, setIsStatsDialogOpen] = useState(false);
    const [isCommandPaletteOpen, setIsCommandPaletteOpen] = useState(false);
    const [command, setCommand] = useState("");
    const [commandMessage, setCommandMessage] = useState("");
    const [searchProgress, setSearchProgress] = useState<number | null>(null);
    const [findResult, setFindResult] = useState<FindResult | null>(null);
    // CanvasはReact DOMを持たないため、Rendererのview変更を再描画へ結び付ける番号を持つ。
    const [renderVersion, setRenderVersion] = useState(0);

    const redraw = useCallback(() => {
        const labelCanvas = labelCanvasRef.current;
        const pipelineCanvas = pipelineCanvasRef.current;
        if (labelCanvas !== null && pipelineCanvas !== null) {
            rendererRef.current.draw(labelCanvas, pipelineCanvas);
        }
    }, []);

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
        setIsCommandPaletteOpen(false);
    }, []);

    const replaceTrace = useCallback((nextTrace: ParsedTrace | null) => {
        // 旧traceの集計結果を新しいfileへ表示しないよう、進行中のrequestもここで無効化する。
        resetStats();
        resetSearch();
        // 将来の圧縮pageやWorkerもtab切替時に解放できるよう、storeのcloseをここへ集約する。
        traceRef.current?.close();
        traceRef.current = nextTrace;
        setTrace(nextTrace);
    }, [resetSearch, resetStats]);

    useEffect(() => () => {
        statsRequestRef.current++;
        searchRequestRef.current++;
        // StrictModeの初回cleanup時点ではまだtraceがなく、実際のunmountでは最新traceを閉じる。
        traceRef.current?.close();
        traceRef.current = null;
    }, []);

    useLayoutEffect(() => {
        rendererRef.current.setTrace(trace);
        redraw();
    }, [redraw, trace]);

    useLayoutEffect(() => {
        const viewer = viewerRef.current;
        if (viewer === null) {
            return;
        }

        // CSS layoutやwindowサイズが変わった時だけbacking storeを再確保する。
        const observer = new ResizeObserver(redraw);
        observer.observe(viewer);
        return () => observer.disconnect();
    }, [redraw]);

    useLayoutEffect(() => {
        redraw();
    }, [redraw, renderVersion]);

    useEffect(() => {
        if (!isCommandPaletteOpen) {
            return;
        }
        const input = commandInputRef.current;
        input?.focus();
        input?.setSelectionRange(input.value.length, input.value.length);
    }, [isCommandPaletteOpen]);

    const loadFile = useCallback(async (file: File) => {
        const requestID = ++loadRequestRef.current;
        resetStats();
        resetSearch();
        setLoadState("loading");
        setFileName(file.name);
        setProgress(0);
        setErrorMessage("");

        try {
            const updateProgress = (value: number) => {
                if (loadRequestRef.current === requestID) {
                    setProgress(value);
                }
            };
            let parsedTrace: ParsedTrace;
            try {
                parsedTrace = await new OnikiriParser().parse(file, updateProgress);
            }
            catch (error) {
                // 現行版と同じ順序で試し、Kanataとして不正な入力だけをgem5へ渡す。
                if (!(error instanceof Error) || error.message !== "The selected file is not a Kanata trace.") {
                    throw error;
                }
                parsedTrace = await new Gem5O3PipeViewParser().parse(file, updateProgress);
            }
            if (loadRequestRef.current !== requestID) {
                parsedTrace.close();
                return;
            }
            replaceTrace(parsedTrace);
            setProgress(1);
            setLoadState("ready");
        }
        catch (error) {
            if (loadRequestRef.current !== requestID) {
                return;
            }
            replaceTrace(null);
            setLoadState("error");
            setErrorMessage(error instanceof Error ? error.message : String(error));
        }
    }, [replaceTrace, resetSearch, resetStats]);

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
        mutation(rendererRef.current);
        setToolTip(null);
        setRenderVersion((version) => version + 1);
    }, []);

    const openCommandPalette = useCallback((initialCommand: string) => {
        if (isStatsDialogOpen) {
            return;
        }
        commandHistoryIndexRef.current = -1;
        setCommand(initialCommand);
        setCommandMessage("");
        setIsCommandPaletteOpen(true);
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

        const activeTrace = traceRef.current;
        if (activeTrace === null) {
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
                    if (searchRequestRef.current !== requestID || traceRef.current !== activeTrace) {
                        return;
                    }
                }
            }

            console.log(`Search finished: ${target}@${foundOp?.id ?? -1}, ${Date.now() - startTime} msec`);
            if (searchRequestRef.current !== requestID || traceRef.current !== activeTrace) {
                return;
            }
            setSearchProgress(null);

            if (foundOp === undefined) {
                setCommandMessage(`"${target}" was not found.`);
                return;
            }

            const renderer = rendererRef.current;
            const viewPosition = renderer.viewPosition;
            const moveTo = renderer.getPositionYFromOp(foundOp);
            let left = viewPosition[0];
            let top = viewPosition[1];
            const pipelineWidth = pipelineCanvasRef.current?.clientWidth ?? 800;
            const labelHeight = labelCanvasRef.current?.clientHeight ?? 400;

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
        const basePosition = rendererRef.current.getPositionYFromOp(findResult.anchorOp);
        findString(findResult.targetPattern, basePosition, reverse);
    }, [findResult, findString]);

    const executeCommand = useCallback(() => {
        let accepted = false;
        const renderer = rendererRef.current;
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
        setIsCommandPaletteOpen(false);
    }, [command, findString, mutateView, resetSearch]);

    const zoomAtCenter = useCallback((factor: number) => {
        const canvas = pipelineCanvasRef.current;
        if (canvas === null) {
            return;
        }
        mutateView((renderer) => renderer.zoomAt(factor, canvas.clientWidth / 2, canvas.clientHeight / 2));
    }, [mutateView]);

    const moveVertical = useCallback((delta: number, adjust: boolean) => {
        const renderer = rendererRef.current;
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

    const handleWheel = (event: WheelEvent<HTMLDivElement>) => {
        if (trace === null) {
            return;
        }
        event.preventDefault();
        if (event.ctrlKey || event.metaKey) {
            const rect = pipelineCanvasRef.current?.getBoundingClientRect();
            const x = rect === undefined ? 0 : Math.max(0, event.clientX - rect.left);
            const y = rect === undefined ? 0 : Math.max(0, event.clientY - rect.top);
            mutateView((renderer) => renderer.zoomAt(event.deltaY < 0 ? 1.2 : 1 / 1.2, x, y));
            return;
        }

        if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
            // trackpadの横移動は、旧キーボード横移動と同じ6cycle単位へ対応させる。
            moveHorizontal(event.deltaX > 0 ? 1 : -1);
            return;
        }

        // 旧wheel操作と同じ3命令単位で移動し、左端を命令のfetch位置へ追従させる。
        moveVertical(event.deltaY > 0 ? 1 : -1, true);
    };

    const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
        if (trace === null || event.button !== 0) {
            return;
        }
        event.currentTarget.setPointerCapture(event.pointerId);
        dragPositionRef.current = { x: event.clientX, y: event.clientY };
        setIsPanning(true);
    };

    const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
        const previous = dragPositionRef.current;
        if (previous === null) {
            return;
        }
        // 紙を掴む感覚に合わせ、pointer移動と逆向きへviewを進める。
        mutateView((renderer) => renderer.panPixels(previous.x - event.clientX, previous.y - event.clientY));
        dragPositionRef.current = { x: event.clientX, y: event.clientY };
    };

    const handlePointerUp = (event: PointerEvent<HTMLDivElement>) => {
        dragPositionRef.current = null;
        setIsPanning(false);
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
        }
    };

    const handleDoubleClick = (event: ReactMouseEvent<HTMLCanvasElement>) => {
        if (trace === null) {
            return;
        }
        const rect = event.currentTarget.getBoundingClientRect();
        mutateView((renderer) => renderer.zoomAt(
            event.shiftKey ? 1 / 2 : 2,
            event.clientX - rect.left,
            event.clientY - rect.top,
        ));
    };

    const handleLabelClick = (event: ReactMouseEvent<HTMLCanvasElement>) => {
        if (trace === null) {
            return;
        }
        const rect = event.currentTarget.getBoundingClientRect();
        const op = rendererRef.current.getOpFromPixelPositionY(event.clientY - rect.top);
        if (op !== undefined) {
            // 旧label paneと同様、縦位置は変えず、選んだ命令のfetch cycleだけを左端へ合わせる。
            mutateView((renderer) => renderer.moveLogicalPosition([
                op.fetchedCycle,
                renderer.viewPosition[1],
            ]));
        }
    };

    const updateToolTip = (
        pane: "label" | "pipeline",
        event: ReactMouseEvent<HTMLCanvasElement>,
    ) => {
        if (trace === null || dragPositionRef.current !== null) {
            setToolTip(null);
            return;
        }
        const canvasRect = event.currentTarget.getBoundingClientRect();
        const viewerRect = viewerRef.current?.getBoundingClientRect();
        if (viewerRect === undefined) {
            return;
        }
        const x = event.clientX - canvasRect.left;
        const y = event.clientY - canvasRect.top;
        const text = pane === "label"
            ? rendererRef.current.getLabelToolTipText(y)
            : rendererRef.current.getPipelineToolTipText(x, y);
        setToolTip(text === null ? null : {
            left: event.clientX - viewerRect.left,
            top: event.clientY - viewerRect.top + 20,
            text,
        });
    };

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
        setStatsFilter("");
        setStatsError("");
        setIsStatsDialogOpen(false);

        void calculateStats(
            trace,
            (value) => {
                if (statsRequestRef.current === requestID) {
                    setStatsProgress(value);
                }
            },
            () => statsRequestRef.current !== requestID || traceRef.current !== trace,
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
            if (isCommandPaletteOpen) {
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
            else {
                handled = false;
            }
            if (handled) {
                event.preventDefault();
            }
        };
        document.addEventListener("keydown", handleKeyDown);
        return () => document.removeEventListener("keydown", handleKeyDown);
    }, [isCommandPaletteOpen, isStatsDialogOpen, moveHorizontal, moveVertical,
        openCommandPalette, repeatSearch, trace, zoomAtCenter]);

    let statsFilterError = "";
    let statsRows: Array<[string, number]> = [];
    if (statsValues !== null) {
        try {
            const filter = new RegExp(statsFilter, "i");
            statsRows = Object.entries(statsValues).filter(([name]) => filter.test(name));
        }
        catch (_error) {
            statsFilterError = "Invalid regular expression.";
        }
    }

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

    const findResultLines = findResult === null
        ? []
        : findResult.foundString.split("\n").filter((line, index) =>
            index === 0 || new RegExp(findResult.targetPattern).test(line));
    const findResultTop = findResult === null
        ? 0
        : Math.floor(rendererRef.current.getPixelPositionYFromOp(findResult.anchorOp)) +
            rendererRef.current.opHeight;

    const operation = loadState === "loading"
        ? { type: "load", value: progress, label: `Loading ${fileName}` }
        : statsProgress !== null
            ? { type: "stats", value: statsProgress, label: "Calculating statistics" }
            : searchProgress !== null
                ? { type: "search", value: searchProgress, label: "Searching trace" }
                : null;

    return (
        <main
            className={`trace-app theme-${rendererRef.current.theme}${isDraggingFile ? " is-dragging-file" : ""}`}
            data-theme={rendererRef.current.theme}
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
            {isCommandPaletteOpen && (
                <section className="command-palette" aria-label="Command palette">
                    <input
                        ref={commandInputRef}
                        autoFocus
                        type="text"
                        aria-label="Command"
                        value={command}
                        onChange={(event) => setCommand(event.target.value)}
                        onBlur={() => setIsCommandPaletteOpen(false)}
                        onKeyDown={(event) => {
                            if (event.key === "Escape") {
                                setIsCommandPaletteOpen(false);
                                event.preventDefault();
                            }
                            else if (event.key === "Enter") {
                                executeCommand();
                                event.preventDefault();
                            }
                            else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
                                commandHistoryIndexRef.current += event.key === "ArrowUp" ? 1 : -1;
                                commandHistoryIndexRef.current = Math.min(
                                    commandHistoryRef.current.length - 1,
                                    Math.max(-1, commandHistoryIndexRef.current),
                                );
                                const historyCommand = commandHistoryIndexRef.current === -1
                                    ? ""
                                    : commandHistoryRef.current[commandHistoryIndexRef.current] ?? "";
                                setCommand(historyCommand);
                                requestAnimationFrame(() => {
                                    const input = commandInputRef.current;
                                    input?.setSelectionRange(input.value.length, input.value.length);
                                });
                                event.preventDefault();
                            }
                        }}
                    />
                    <div className="command-hints">
                        {COMMAND_HINTS.map(([text, syntax]) => (
                            <div className="command-hint" key={syntax}>
                                <span>{text}</span>
                                <code>{syntax}</code>
                            </div>
                        ))}
                    </div>
                </section>
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
                    <output>{rendererRef.current.zoomPercent}%</output>
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
                                value={rendererRef.current.theme}
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
                                checked={rendererRef.current.hideFlushedOps}
                                disabled={trace === null}
                                onChange={(event) => toggleHideFlushedOps(event.target.checked)}
                            />
                            Hide flushed ops
                        </label>
                        <label>
                            <input
                                type="checkbox"
                                aria-label="Split lanes"
                                checked={rendererRef.current.splitLanes}
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
                                checked={rendererRef.current.fixOpHeight}
                                disabled={trace === null || !rendererRef.current.splitLanes}
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
                                value={rendererRef.current.colorScheme}
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
                                value={rendererRef.current.dependencyArrowType}
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
                                        value={rendererRef.current[key]}
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

            <div
                ref={viewerRef}
                className={`viewer${isPanning ? " is-panning" : ""}`}
                onWheel={handleWheel}
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
                onPointerCancel={handlePointerUp}
            >
                <section className="viewer-pane label-pane" aria-label="Instruction labels">
                    <canvas
                        ref={labelCanvasRef}
                        aria-label="Instruction labels canvas"
                        onPointerDown={(event) => event.stopPropagation()}
                        onClick={handleLabelClick}
                        onMouseMove={(event) => updateToolTip("label", event)}
                        onMouseLeave={() => setToolTip(null)}
                    >
                        Instruction labels require canvas support.
                    </canvas>
                </section>
                <section className="viewer-pane pipeline-pane" aria-label="Pipeline chart">
                    <canvas
                        ref={pipelineCanvasRef}
                        aria-label="Pipeline canvas"
                        onDoubleClick={handleDoubleClick}
                        onMouseMove={(event) => updateToolTip("pipeline", event)}
                        onMouseLeave={() => setToolTip(null)}
                    >
                        The pipeline chart requires canvas support.
                    </canvas>
                </section>
                {trace === null && loadState !== "loading" && (
                    <div className="empty-state">
                        <strong>{loadState === "error" ? "The trace could not be opened." : "Drop a trace anywhere in this window."}</strong>
                        <span>{loadState === "error" ? "Choose another trace to try again." : "Plain text and gzip files are supported."}</span>
                    </div>
                )}
                {toolTip !== null && (
                    <pre
                        className="canvas-tooltip"
                        role="tooltip"
                        style={{ left: toolTip.left, top: toolTip.top }}
                    >
                        {toolTip.text}
                    </pre>
                )}
                {findResult !== null && (
                    <div
                        className="find-result"
                        data-op-id={findResult.op.id}
                        style={{ top: findResultTop }}
                        onPointerDown={(event) => event.stopPropagation()}
                    >
                        <div className="find-result-content">
                            {rendererRef.current.hideFlushedOps && findResult.flushed && (
                                <div>A found op is not shown because it is flushed.</div>
                            )}
                            {findResultLines.map((line, lineIndex) => (
                                <div key={`${lineIndex}:${line}`}>
                                    {highlightMatches(line, findResult.targetPattern).map((part, partIndex) => (
                                        <span className={part.matched ? "find-result-match" : undefined} key={partIndex}>
                                            {part.text}
                                        </span>
                                    ))}
                                </div>
                            ))}
                        </div>
                        <button
                            type="button"
                            aria-label="Close search result"
                            onClick={() => setFindResult(null)}
                        >
                            ×
                        </button>
                    </div>
                )}
            </div>
            {isStatsDialogOpen && (
                <div
                    className="dialog-backdrop"
                    onMouseDown={(event) => {
                        if (event.target === event.currentTarget) {
                            closeStatsDialog();
                        }
                    }}
                >
                    <section className="stats-dialog" role="dialog" aria-modal="true" aria-labelledby="stats-dialog-title">
                        <header>
                            <h2 id="stats-dialog-title">Stats</h2>
                            <button type="button" aria-label="Close statistics" onClick={closeStatsDialog}>×</button>
                        </header>
                        {statsError === "" ? (
                            <>
                                <input
                                    autoFocus
                                    type="text"
                                    aria-label="Filter statistics"
                                    placeholder="Filter pattern for 'Name' column"
                                    value={statsFilter}
                                    onChange={(event) => setStatsFilter(event.target.value)}
                                />
                                {statsFilterError !== "" && <p className="stats-error">{statsFilterError}</p>}
                                <div className="stats-table-container">
                                    <table>
                                        <thead>
                                            <tr><th>Name</th><th>Value</th></tr>
                                        </thead>
                                        <tbody>
                                            {statsRows.map(([name, value]) => (
                                                <tr key={name}><td>{name}</td><td>{String(value)}</td></tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                            </>
                        ) : (
                            <p className="stats-error">{statsError}</p>
                        )}
                        <footer>
                            <button type="button" onClick={closeStatsDialog}>OK</button>
                        </footer>
                    </section>
                </div>
            )}
        </main>
    );
}
