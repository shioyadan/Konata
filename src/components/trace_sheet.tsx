import {
    forwardRef,
    type MouseEvent as ReactMouseEvent,
    type PointerEvent,
    useCallback,
    useImperativeHandle,
    useLayoutEffect,
    useRef,
    useState,
} from "react";

import type { ParsedTrace } from "../core/model";
import { KonataRenderer } from "../renderer/konata_renderer";
import type { FindResult, LoadState } from "../store";

interface HighlightedText {
    readonly text: string;
    readonly matched: boolean;
}

interface DragPosition {
    readonly x: number;
    readonly y: number;
}

interface CanvasToolTip {
    readonly left: number;
    readonly top: number;
    readonly text: string;
}

export interface TraceSheetHandle {
    clearToolTip(): void;
    getViewportSize(): {
        readonly pipelineWidth: number;
        readonly pipelineHeight: number;
        readonly labelHeight: number;
    };
}

interface TraceSheetProps {
    readonly renderer: KonataRenderer;
    readonly trace: ParsedTrace | null;
    readonly loadState: LoadState;
    readonly renderVersion: number;
    readonly findResult: FindResult | null;
    readonly splitterPosition: number;
    readonly onMoveSplitter: (position: number) => void;
    readonly onMutateView: (mutation: (renderer: KonataRenderer) => void) => void;
    readonly onCloseFindResult: () => void;
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

// 旧app_sheetに相当し、label/pipeline Canvasとその直接操作を同じ単位で所有する。
export const TraceSheet = forwardRef<TraceSheetHandle, TraceSheetProps>(function TraceSheet({
    renderer,
    trace,
    loadState,
    renderVersion,
    findResult,
    splitterPosition,
    onMoveSplitter,
    onMutateView,
    onCloseFindResult,
}, ref) {
    const viewerRef = useRef<HTMLDivElement>(null);
    const labelCanvasRef = useRef<HTMLCanvasElement>(null);
    const pipelineCanvasRef = useRef<HTMLCanvasElement>(null);
    const dragPositionRef = useRef<DragPosition | null>(null);
    const splitterDraggingRef = useRef(false);
    const [isPanning, setIsPanning] = useState(false);
    const [isResizing, setIsResizing] = useState(false);
    const [toolTip, setToolTip] = useState<CanvasToolTip | null>(null);

    const redraw = useCallback(() => {
        const labelCanvas = labelCanvasRef.current;
        const pipelineCanvas = pipelineCanvasRef.current;
        if (labelCanvas !== null && pipelineCanvas !== null) {
            renderer.draw(labelCanvas, pipelineCanvas);
        }
    }, [renderer]);

    useImperativeHandle(ref, () => ({
        clearToolTip: () => setToolTip(null),
        getViewportSize: () => ({
            pipelineWidth: pipelineCanvasRef.current?.clientWidth ?? 800,
            pipelineHeight: pipelineCanvasRef.current?.clientHeight ?? 400,
            labelHeight: labelCanvasRef.current?.clientHeight ?? 400,
        }),
    }), []);

    useLayoutEffect(() => {
        renderer.setTrace(trace);
        redraw();
    }, [redraw, renderer, trace]);

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

    useLayoutEffect(() => {
        const handleMouseMove = (event: MouseEvent) => {
            const viewer = viewerRef.current;
            if (!splitterDraggingRef.current || viewer === null) {
                return;
            }
            const rect = viewer.getBoundingClientRect();
            // ウィンドウ外までdragしても、どちらかのpaneが負の幅にならないよう補正する。
            const position = Math.min(Math.max(event.clientX - rect.left, 0), Math.max(0, rect.width - 10));
            onMoveSplitter(position);
        };
        const handleMouseUp = () => {
            splitterDraggingRef.current = false;
            setIsResizing(false);
        };
        window.addEventListener("mousemove", handleMouseMove);
        window.addEventListener("mouseup", handleMouseUp);
        return () => {
            window.removeEventListener("mousemove", handleMouseMove);
            window.removeEventListener("mouseup", handleMouseUp);
        };
    }, [onMoveSplitter]);

    const handleWheel = useCallback((event: WheelEvent) => {
        if (trace === null) {
            return;
        }
        event.preventDefault();
        if (event.ctrlKey || event.metaKey) {
            const rect = pipelineCanvasRef.current?.getBoundingClientRect();
            const x = rect === undefined ? 0 : Math.max(0, event.clientX - rect.left);
            const y = rect === undefined ? 0 : Math.max(0, event.clientY - rect.top);
            onMutateView((target) => target.zoomAt(event.deltaY < 0 ? 1.2 : 1 / 1.2, x, y));
            return;
        }

        if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
            // trackpadの横移動は、旧キーボード横移動と同じ6cycle単位へ対応させる。
            onMutateView((target) => target.moveLogicalDifference([
                (event.deltaX > 0 ? 1 : -1) * 6 / target.zoomScale,
                0,
            ], false));
            return;
        }

        // 旧wheel操作と同じ3命令単位で移動し、左端を命令のfetch位置へ追従させる。
        const differenceY = (event.deltaY > 0 ? 1 : -1) * 3 / renderer.zoomScale;
        const differenceX = renderer.adjustScrollDifferenceX(differenceY);
        onMutateView((target) => target.moveLogicalDifference([differenceX, differenceY], false));
    }, [onMutateView, renderer, trace]);

    useLayoutEffect(() => {
        const viewer = viewerRef.current;
        if (viewer === null) {
            return;
        }
        // Reactのpassiveなwheel委譲ではCtrl+wheelのbrowser zoomを止められないため、ここだけ直接購読する。
        viewer.addEventListener("wheel", handleWheel, { passive: false });
        return () => viewer.removeEventListener("wheel", handleWheel);
    }, [handleWheel]);

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
        onMutateView((target) => target.panPixels(previous.x - event.clientX, previous.y - event.clientY));
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
        onMutateView((target) => target.zoomAt(
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
        const op = renderer.getOpFromPixelPositionY(event.clientY - rect.top);
        if (op !== undefined) {
            // 旧label paneと同様、縦位置は変えず、選んだ命令のfetch cycleだけを左端へ合わせる。
            onMutateView((target) => target.moveLogicalPosition([
                op.fetchedCycle,
                target.viewPosition[1],
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
            ? renderer.getLabelToolTipText(y)
            : renderer.getPipelineToolTipText(x, y);
        setToolTip(text === null ? null : {
            left: event.clientX - viewerRect.left,
            top: event.clientY - viewerRect.top + 20,
            text,
        });
    };

    const findResultLines = findResult === null
        ? []
        : findResult.foundString.split("\n").filter((line, index) =>
            index === 0 || new RegExp(findResult.targetPattern).test(line));
    const findResultTop = findResult === null
        ? 0
        : Math.floor(renderer.getPixelPositionYFromOp(findResult.anchorOp)) + renderer.opHeight;

    return (
        <div
            ref={viewerRef}
            className={`viewer${isPanning ? " is-panning" : ""}${isResizing ? " is-resizing" : ""}`}
            style={{
                gridTemplateColumns:
                    `minmax(0, min(${splitterPosition}px, calc(100% - 10px))) 10px minmax(0, 1fr)`,
            }}
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
            <div
                className="pane-splitter"
                role="separator"
                aria-label="Resize instruction labels"
                aria-orientation="vertical"
                aria-valuemin={0}
                aria-valuenow={Math.round(splitterPosition)}
                onPointerDown={(event) => event.stopPropagation()}
                onMouseDown={(event) => {
                    if (event.button !== 0) {
                        return;
                    }
                    // 旧splitter_windowと同じく、drag中はwindow側でmove/upを追跡する。
                    splitterDraggingRef.current = true;
                    setIsResizing(true);
                    event.preventDefault();
                    event.stopPropagation();
                }}
            />
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
                        {renderer.hideFlushedOps && findResult.flushed && (
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
                    <button type="button" aria-label="Close search result" onClick={onCloseFindResult}>×</button>
                </div>
            )}
        </div>
    );
});
