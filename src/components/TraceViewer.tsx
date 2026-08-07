import {
    type ChangeEvent,
    type DragEvent,
    type PointerEvent,
    type WheelEvent,
    useCallback,
    useLayoutEffect,
    useRef,
    useState,
} from "react";

import type { ParsedTrace } from "../core/model";
import { OnikiriParser } from "../core/onikiri_parser";
import { KonataRenderer } from "../renderer/konata_renderer";

type LoadState = "idle" | "loading" | "ready" | "error";

interface DragPosition {
    x: number;
    y: number;
}

export function TraceViewer() {
    const fileInputRef = useRef<HTMLInputElement>(null);
    const viewerRef = useRef<HTMLDivElement>(null);
    const labelCanvasRef = useRef<HTMLCanvasElement>(null);
    const pipelineCanvasRef = useRef<HTMLCanvasElement>(null);
    const rendererRef = useRef(new KonataRenderer());
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
    // CanvasはReact DOMを持たないため、Rendererのview変更を再描画へ結び付ける番号を持つ。
    const [renderVersion, setRenderVersion] = useState(0);

    const redraw = useCallback(() => {
        const labelCanvas = labelCanvasRef.current;
        const pipelineCanvas = pipelineCanvasRef.current;
        if (labelCanvas !== null && pipelineCanvas !== null) {
            rendererRef.current.draw(labelCanvas, pipelineCanvas);
        }
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
            const parsedTrace = await new OnikiriParser().parse(file, (value) => {
                if (loadRequestRef.current === requestID) {
                    setProgress(value);
                }
            });
            if (loadRequestRef.current !== requestID) {
                return;
            }
            setTrace(parsedTrace);
            setProgress(1);
            setLoadState("ready");
        }
        catch (error) {
            if (loadRequestRef.current !== requestID) {
                return;
            }
            setTrace(null);
            setLoadState("error");
            setErrorMessage(error instanceof Error ? error.message : String(error));
        }
    }, []);

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
        const lineScale = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : 1;
        if (event.ctrlKey || event.metaKey) {
            const rect = pipelineCanvasRef.current?.getBoundingClientRect();
            const x = rect === undefined ? 0 : Math.max(0, event.clientX - rect.left);
            const y = rect === undefined ? 0 : Math.max(0, event.clientY - rect.top);
            mutateView((renderer) => renderer.zoomAt(event.deltaY < 0 ? 1.2 : 1 / 1.2, x, y));
            return;
        }

        // 通常wheelは縦、Shift+wheelは横へ送る。trackpadのdeltaXはそのまま使う。
        const horizontal = event.deltaX + (event.shiftKey ? event.deltaY : 0);
        const vertical = event.shiftKey ? 0 : event.deltaY;
        mutateView((renderer) => renderer.panPixels(horizontal * lineScale, vertical * lineScale));
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

    let statusMessage = "Open or drop a Kanata trace (.log or .log.gz).";
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
                    <canvas ref={labelCanvasRef} aria-label="Instruction labels canvas">
                        Instruction labels require canvas support.
                    </canvas>
                </section>
                <section className="viewer-pane pipeline-pane" aria-label="Pipeline chart">
                    <div className="pane-title">Pipeline</div>
                    <canvas ref={pipelineCanvasRef} aria-label="Pipeline canvas">
                        The pipeline chart requires canvas support.
                    </canvas>
                </section>
                {trace === null && loadState !== "loading" && (
                    <div className="empty-state">
                        <strong>{loadState === "error" ? "The trace could not be opened." : "Drop a trace anywhere in this window."}</strong>
                        <span>{loadState === "error" ? "Choose another Kanata file to try again." : "Plain text and gzip files are supported."}</span>
                    </div>
                )}
                {loadState === "loading" && (
                    <div className="loading-state" aria-hidden="true">
                        <div className="progress-track"><div style={{ width: `${Math.round(progress * 100)}%` }} /></div>
                    </div>
                )}
            </div>
        </main>
    );
}
