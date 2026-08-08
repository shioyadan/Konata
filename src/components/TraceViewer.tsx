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

import type { ParsedTrace } from "../core/model";
import { Gem5O3PipeViewParser } from "../core/gem5_o3_pipe_view_parser";
import { OnikiriParser } from "../core/onikiri_parser";
import {
    DEP_ARROW_TYPE,
    KonataRenderer,
    type DependencyArrowType,
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

export function TraceViewer() {
    const fileInputRef = useRef<HTMLInputElement>(null);
    const viewerRef = useRef<HTMLDivElement>(null);
    const labelCanvasRef = useRef<HTMLCanvasElement>(null);
    const pipelineCanvasRef = useRef<HTMLCanvasElement>(null);
    const rendererRef = useRef(new KonataRenderer());
    const traceRef = useRef<ParsedTrace | null>(null);
    // 複数ファイルが続けて選ばれた場合、遅く完了した旧requestで表示を上書きしない。
    const loadRequestRef = useRef(0);
    const dragPositionRef = useRef<DragPosition | null>(null);

    const [trace, setTrace] = useState<ParsedTrace | null>(null);
    const [loadState, setLoadState] = useState<LoadState>("idle");
    const [fileName, setFileName] = useState("");
    const [progress, setProgress] = useState(0);
    const [errorMessage, setErrorMessage] = useState("");
    const [isDraggingFile, setIsDraggingFile] = useState(false);
    const [isPanning, setIsPanning] = useState(false);
    const [toolTip, setToolTip] = useState<CanvasToolTip | null>(null);
    // CanvasはReact DOMを持たないため、Rendererのview変更を再描画へ結び付ける番号を持つ。
    const [renderVersion, setRenderVersion] = useState(0);

    const redraw = useCallback(() => {
        const labelCanvas = labelCanvasRef.current;
        const pipelineCanvas = pipelineCanvasRef.current;
        if (labelCanvas !== null && pipelineCanvas !== null) {
            rendererRef.current.draw(labelCanvas, pipelineCanvas);
        }
    }, []);

    const replaceTrace = useCallback((nextTrace: ParsedTrace | null) => {
        // 将来の圧縮pageやWorkerもtab切替時に解放できるよう、storeのcloseをここへ集約する。
        traceRef.current?.close();
        traceRef.current = nextTrace;
        setTrace(nextTrace);
    }, []);

    useEffect(() => () => {
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

    const loadFile = useCallback(async (file: File) => {
        const requestID = ++loadRequestRef.current;
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
    }, [replaceTrace]);

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

    const mutateView = (mutation: (renderer: KonataRenderer) => void) => {
        mutation(rendererRef.current);
        setToolTip(null);
        setRenderVersion((version) => version + 1);
    };

    const zoomAtCenter = (factor: number) => {
        const canvas = pipelineCanvasRef.current;
        if (canvas === null) {
            return;
        }
        mutateView((renderer) => renderer.zoomAt(factor, canvas.clientWidth / 2, canvas.clientHeight / 2));
    };

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

        const renderer = rendererRef.current;
        if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
            // trackpadの横移動は、旧キーボード横移動と同じ6cycle単位へ対応させる。
            const direction = event.deltaX > 0 ? 1 : -1;
            mutateView((target) => target.moveLogicalDifference([
                direction * 6 / target.zoomScale,
                0,
            ], false));
            return;
        }

        // 旧wheel操作と同じ3命令単位で移動し、左端を命令のfetch位置へ追従させる。
        const direction = event.deltaY > 0 ? 1 : -1;
        const differenceY = direction * 3 / renderer.zoomScale;
        const differenceX = renderer.adjustScrollDifferenceX(differenceY);
        mutateView((target) => target.moveLogicalDifference([differenceX, differenceY], false));
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

    return (
        <main
            className={`trace-app${isDraggingFile ? " is-dragging-file" : ""}`}
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
            <header className="app-toolbar">
                <h1>Konata Web</h1>
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
                    </div>
                </details>
                <p className={`status status-${loadState}`} role="status">{statusMessage}</p>
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
                    <div className="pane-title">Instructions</div>
                    <canvas
                        ref={labelCanvasRef}
                        aria-label="Instruction labels canvas"
                        onDoubleClick={handleDoubleClick}
                        onMouseMove={(event) => updateToolTip("label", event)}
                        onMouseLeave={() => setToolTip(null)}
                    >
                        Instruction labels require canvas support.
                    </canvas>
                </section>
                <section className="viewer-pane pipeline-pane" aria-label="Pipeline chart">
                    <div className="pane-title">Pipeline</div>
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
                {loadState === "loading" && (
                    <div className="loading-state" aria-hidden="true">
                        <div className="progress-track"><div style={{ width: `${Math.round(progress * 100)}%` }} /></div>
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
            </div>
        </main>
    );
}
