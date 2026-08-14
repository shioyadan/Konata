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
import { BsX } from "react-icons/bs";

import type { ParsedTrace } from "../core/model";
import {
    COMPARISON_COLOR_SCHEME,
    clampKonataZoomLevel,
    getKonataView,
    KonataRenderMetrics,
    KonataRenderer,
    type KonataRenderSpec,
    type KonataView,
} from "../core/konata_renderer";
import { TiledPipelineRenderer } from "../core/tiled_pipeline_renderer";
import type {
    ComparisonMode,
    FindResult,
    LoadState,
    ViewTransition,
    ViewTransitionAction,
    ViewTransitionMotion,
} from "../store";

declare const __KONATA_VERSION__: string;
declare const __KONATA_COMMIT__: string;
declare const __KONATA_COMMIT_DATE__: string;

interface HighlightedText {
    readonly text: string;
    readonly matched: boolean;
}

interface PointerPosition {
    readonly x: number;
    readonly y: number;
}

interface CanvasToolTip {
    readonly left: number;
    readonly top: number;
    readonly text: string;
}

// A/B単独表示では、位置合わせ用の反対側だけを控えめに重ねる。
const COMPARISON_REFERENCE_OPACITY = 0.2;
const ZOOM_ANIMATION_DURATION = 80;
const SCROLL_ANIMATION_DURATION = 100;
const VIEW_ANIMATION_DURATION = 200;
const BOOKMARK_ZOOM_ANIMATION_DURATION = 160;

export interface TraceSheetHandle {
    clearToolTip(): void;
    resetPipelineCanvas(): void;
    cancelViewTransition(): void;
    scrollTo(
        position: readonly [number, number],
        baselinePosition?: readonly [number, number],
    ): void;
    zoomAt(factor: number, centerX: number, centerY: number): void;
    goToView(view: KonataView): void;
    resetView(): void;
    getRenderedSpec(): Readonly<KonataRenderSpec>;
    getViewportSize(): {
        readonly pipelineWidth: number;
        readonly pipelineHeight: number;
        readonly labelHeight: number;
    };
}

interface TraceSheetProps {
    readonly trace: ParsedTrace | null;
    readonly tabID: number | null;
    readonly renderSpec: Readonly<KonataRenderSpec>;
    readonly loadState: LoadState;
    readonly errorMessage: string;
    readonly renderVersion: number;
    readonly webGLEnabled: boolean;
    readonly tiledRenderingEnabled: boolean;
    readonly zoomStep: number;
    readonly viewTransition: Readonly<ViewTransition> | null;
    readonly findResult: FindResult | null;
    readonly comparison: {
        readonly baselineTrace: ParsedTrace | null;
        readonly baselineRenderSpec: Readonly<KonataRenderSpec>;
        readonly mode: ComparisonMode;
        readonly opacity: number;
    } | null;
    readonly splitterPosition: number;
    readonly onMoveSplitter: (position: number) => void;
    readonly onPanView: (deltaX: number, deltaY: number) => void;
    readonly onPinchView: (
        panDeltaX: number,
        panDeltaY: number,
        zoomLevelDifference: number,
        centerX: number,
        centerY: number,
    ) => void;
    readonly onMoveView: (difference: readonly [number, number], adjustHorizontal: boolean) => void;
    readonly onRenderedZoomChange: (zoomLevel: number) => void;
    readonly onViewAction: (action: ViewTransitionAction) => void;
    readonly onCloseFindResult: () => void;
    readonly onOpenTrace: () => void;
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

function interpolateRenderSpec(
    trace: ParsedTrace | null,
    from: Readonly<KonataRenderSpec>,
    target: KonataView,
    motion: Readonly<ViewTransitionMotion>,
    progress: number,
): Readonly<KonataRenderSpec> {
    if (progress >= 1) {
        return { ...from, ...target };
    }
    const zoomProgress = motion.type === "linear" && motion.zoomDuration !== undefined
        ? Math.min(1, progress * motion.duration / motion.zoomDuration)
        : progress;
    const zoomLevel = from.zoomLevel + (target.zoomLevel - from.zoomLevel) * zoomProgress;
    if (motion.type === "zoomAt") {
        return new KonataRenderMetrics(trace, from).withZoomLevel(
            zoomLevel,
            motion.centerX,
            motion.centerY,
        );
    }
    return {
        ...from,
        zoomLevel,
        position: [
            from.position[0] + (target.position[0] - from.position[0]) * progress,
            from.position[1] + (target.position[1] - from.position[1]) * progress,
        ],
    };
}

// 旧app_sheetに相当し、label/pipeline Canvasとその直接操作を同じ単位で所有する。
export const TraceSheet = forwardRef<TraceSheetHandle, TraceSheetProps>(function TraceSheet({
    trace,
    tabID,
    renderSpec,
    loadState,
    errorMessage,
    renderVersion,
    webGLEnabled,
    tiledRenderingEnabled,
    zoomStep,
    viewTransition,
    findResult,
    comparison,
    splitterPosition,
    onMoveSplitter,
    onPanView,
    onPinchView,
    onMoveView,
    onRenderedZoomChange,
    onViewAction,
    onCloseFindResult,
    onOpenTrace,
}, ref) {
    const viewerRef = useRef<HTMLDivElement>(null);
    const labelCanvasRef = useRef<HTMLCanvasElement>(null);
    const pipelineCanvasRef = useRef<HTMLCanvasElement>(null);
    const baselineLayerCanvasRef = useRef<HTMLCanvasElement | null>(null);
    const candidateLayerCanvasRef = useRef<HTMLCanvasElement | null>(null);
    const findResultRef = useRef<HTMLDivElement>(null);
    const rendererRef = useRef<KonataRenderer | null>(null);
    const baselineRendererRef = useRef<KonataRenderer | null>(null);
    // 通常側と比較baseline側は描画入力もtile namespaceも異なるため、Rendererとcacheを共有しない。
    const tiledRendererRef = useRef<TiledPipelineRenderer | null>(null);
    const baselineTiledRendererRef = useRef<TiledPipelineRenderer | null>(null);
    if (rendererRef.current === null) {
        rendererRef.current = new KonataRenderer();
    }
    if (baselineRendererRef.current === null) {
        baselineRendererRef.current = new KonataRenderer();
    }
    const renderer = rendererRef.current;
    if (tiledRendererRef.current === null) {
        tiledRendererRef.current = new TiledPipelineRenderer(renderer);
    }
    if (baselineTiledRendererRef.current === null) {
        baselineTiledRendererRef.current = new TiledPipelineRenderer(baselineRendererRef.current);
    }
    const tiledRenderer = tiledRendererRef.current;
    const baselineTiledRenderer = baselineTiledRendererRef.current;
    const baselineRenderer = comparison === null ? null : baselineRendererRef.current;
    const baselineTrace = comparison?.baselineTrace ?? null;
    const baselineRenderSpec = comparison?.baselineRenderSpec ?? null;
    // Storeには端点だけを置き、実際に描いた中間Specと連続入力の次の目標はCanvas側で保持する。
    const renderedSpecRef = useRef(renderSpec);
    const renderedBaselineSpecRef = useRef<Readonly<KonataRenderSpec> | undefined>(
        baselineRenderSpec ?? undefined,
    );
    const transitionClockRef = useRef<{ readonly id: number; readonly startedAt: number } | null>(null);
    const requestedTransitionRef = useRef<{
        readonly target: KonataView;
        readonly baselineTarget?: KonataView;
    } | null>(null);
    if (viewTransition === null) {
        renderedSpecRef.current = renderSpec;
        renderedBaselineSpecRef.current = baselineRenderSpec ?? undefined;
        requestedTransitionRef.current = null;
    }
    else {
        requestedTransitionRef.current = {
            target: viewTransition.target,
            baselineTarget: viewTransition.baselineTarget,
        };
    }
    const metrics = new KonataRenderMetrics(trace, renderSpec);
    const baselineMetrics = baselineRenderSpec === null
        ? null
        : new KonataRenderMetrics(baselineTrace, baselineRenderSpec);
    const pointerPositionsRef = useRef(new Map<number, PointerPosition>());
    const splitterDraggingRef = useRef(false);
    const [isPanning, setIsPanning] = useState(false);
    const [isResizing, setIsResizing] = useState(false);
    const [toolTip, setToolTip] = useState<CanvasToolTip | null>(null);
    const comparisonMode = comparison?.mode ?? null;
    const comparisonOpacity = comparison?.opacity ?? 1;
    // A単独表示だけはラベルとマウス参照もAへ切り替え、それ以外はBを前面の情報源にする。
    const displayRenderer = comparisonMode === "baseline" && baselineRenderer !== null
        ? baselineRenderer
        : renderer;
    const displayMetrics = comparisonMode === "baseline" && baselineMetrics !== null
        ? baselineMetrics
        : metrics;
    const displayMetricsRef = useRef(displayMetrics);
    if (viewTransition === null) {
        displayMetricsRef.current = displayMetrics;
    }

    const startViewTransition = useCallback((
        target: KonataView,
        baselineTarget: KonataView | undefined,
        motion: Readonly<ViewTransitionMotion>,
    ) => {
        if (tabID === null) {
            return;
        }
        const from = getKonataView(renderedSpecRef.current);
        const baselineFromSpec = renderedBaselineSpecRef.current;
        const baselineFrom = baselineFromSpec === undefined
            ? undefined
            : getKonataView(baselineFromSpec);
        requestedTransitionRef.current = { target, baselineTarget };
        setToolTip(null);
        onViewAction({
            type: "KONATA_VIEW_TRANSITION_START",
            tabID,
            from,
            target,
            baselineFrom,
            baselineTarget,
            motion,
        });
    }, [onViewAction, tabID]);

    const cancelViewTransition = useCallback(() => {
        if (requestedTransitionRef.current === null) {
            return;
        }
        requestedTransitionRef.current = null;
        if (tabID !== null) {
            onViewAction({
                type: "KONATA_SET_VIEW",
                tabID,
                view: getKonataView(renderedSpecRef.current),
                baselineView: renderedBaselineSpecRef.current === undefined
                    ? undefined
                    : getKonataView(renderedBaselineSpecRef.current),
            });
        }
    }, [onViewAction, tabID]);

    const scrollTo = useCallback((
        position: readonly [number, number],
        baselinePosition?: readonly [number, number],
    ) => {
        const from = renderedSpecRef.current;
        const baselineFrom = renderedBaselineSpecRef.current;
        const applyCandidate = comparisonMode !== "baseline";
        const applyBaseline = baselineFrom !== undefined && comparisonMode !== "candidate";
        const targetPosition = applyCandidate ? position : from.position;
        const baselineTargetPosition = !applyBaseline
            ? baselineFrom?.position
            : baselinePosition ?? [
                baselineFrom.position[0] + targetPosition[0] - from.position[0],
                baselineFrom.position[1] + targetPosition[1] - from.position[1],
            ];
        startViewTransition(
            { position: targetPosition, zoomLevel: from.zoomLevel },
            baselineFrom === undefined || baselineTargetPosition === undefined
                ? undefined
                : { position: baselineTargetPosition, zoomLevel: baselineFrom.zoomLevel },
            { type: "linear", duration: SCROLL_ANIMATION_DURATION },
        );
    }, [comparisonMode, startViewTransition]);

    const zoomAt = useCallback((factor: number, centerX: number, centerY: number) => {
        if (factor === 1) {
            return;
        }
        const from = renderedSpecRef.current;
        const baselineFrom = renderedBaselineSpecRef.current;
        const baseLevel = requestedTransitionRef.current?.target.zoomLevel ?? from.zoomLevel;
        const zoomLevel = clampKonataZoomLevel(baseLevel + (factor > 1 ? -zoomStep : zoomStep));
        startViewTransition(
            getKonataView(new KonataRenderMetrics(trace, from).withZoomLevel(
                zoomLevel, centerX, centerY)),
            baselineFrom === undefined
                ? undefined
                : getKonataView(new KonataRenderMetrics(
                    baselineTrace,
                    baselineFrom,
                ).withZoomLevel(zoomLevel, centerX, centerY)),
            { type: "zoomAt", duration: ZOOM_ANIMATION_DURATION, centerX, centerY },
        );
    }, [baselineTrace, startViewTransition, trace, zoomStep]);

    const transitionToView = useCallback((
        target: KonataView,
        motion: Readonly<ViewTransitionMotion>,
    ) => {
        const from = renderedSpecRef.current;
        const baselineFrom = renderedBaselineSpecRef.current;
        const differenceX = target.position[0] - from.position[0];
        const differenceY = target.position[1] - from.position[1];
        startViewTransition(
            target,
            baselineFrom === undefined ? undefined : {
                position: [
                    baselineFrom.position[0] + differenceX,
                    baselineFrom.position[1] + differenceY,
                ],
                zoomLevel: target.zoomLevel,
            },
            motion,
        );
    }, [startViewTransition]);

    const goToView = useCallback((target: KonataView) => transitionToView(target, {
        type: "linear",
        duration: VIEW_ANIMATION_DURATION,
        zoomDuration: BOOKMARK_ZOOM_ANIMATION_DURATION,
    }), [transitionToView]);

    const resetView = useCallback(() => transitionToView(
        { position: [0, 0], zoomLevel: 0 },
        { type: "linear", duration: VIEW_ANIMATION_DURATION },
    ), [transitionToView]);

    const resetPipelineCanvases = useCallback(() => {
        tiledRenderer.clear();
        baselineTiledRenderer.clear();
        renderer.releaseCanvasResources();
        baselineRenderer?.releaseCanvasResources();
        for (const canvas of [
            pipelineCanvasRef.current,
            baselineLayerCanvasRef.current,
            candidateLayerCanvasRef.current,
        ]) {
            if (canvas !== null) {
                // software Canvasの遅延描画資源を、参照中のTraceより先に切り離す。
                canvas.width = 1;
                canvas.height = 1;
            }
        }
    }, [baselineRenderer, baselineTiledRenderer, renderer, tiledRenderer]);

    const drawSpecs = useCallback((
        candidateSpec: Readonly<KonataRenderSpec>,
        currentBaselineSpec?: Readonly<KonataRenderSpec>,
        candidatePrefetchSpec?: Readonly<KonataRenderSpec>,
        baselinePrefetchSpec?: Readonly<KonataRenderSpec>,
    ) => {
        const labelCanvas = labelCanvasRef.current;
        const pipelineCanvas = pipelineCanvasRef.current;
        renderedSpecRef.current = candidateSpec;
        renderedBaselineSpecRef.current = currentBaselineSpec;
        const candidateMetrics = new KonataRenderMetrics(trace, candidateSpec);
        onRenderedZoomChange(candidateSpec.zoomLevel);
        const currentBaselineMetrics = currentBaselineSpec === undefined
            ? null
            : new KonataRenderMetrics(baselineTrace, currentBaselineSpec);
        displayMetricsRef.current = comparisonMode === "baseline" && currentBaselineMetrics !== null
            ? currentBaselineMetrics
            : candidateMetrics;
        if (findResult !== null && findResultRef.current !== null) {
            findResultRef.current.style.top = `${
                Math.floor(candidateMetrics.getPixelPositionYFromID(findResult.anchorID)) +
                candidateMetrics.opHeight
            }px`;
        }
        const tileOptions = {
            // Parser追記中と互換設定での無効時は、raster tileを介さず直接描画する。
            cacheEnabled: tiledRenderingEnabled && loadState === "ready",
            webGLEnabled,
        } as const;
        const candidateTileOptions = {
            ...tileOptions,
            prefetchSpec: candidatePrefetchSpec,
        } as const;
        const baselineTileOptions = {
            ...tileOptions,
            prefetchSpec: baselinePrefetchSpec,
        } as const;
        if (labelCanvas !== null && pipelineCanvas !== null) {
            if (baselineRenderer === null || comparisonMode === null || currentBaselineSpec === undefined) {
                renderer.drawLabelSpec(trace, candidateSpec, labelCanvas);
                tiledRenderer.drawPipelineSpec(trace, candidateSpec, pipelineCanvas, candidateTileOptions);
                delete pipelineCanvas.dataset.comparisonMode;
                return;
            }

            const displayTrace = comparisonMode === "baseline" ? baselineTrace : trace;
            const displaySpec = comparisonMode === "baseline" ? currentBaselineSpec : candidateSpec;
            displayRenderer.drawLabelSpec(displayTrace, displaySpec, labelCanvas);
            pipelineCanvas.dataset.comparisonMode = comparisonMode;
            // A/Bをそれぞれ不透明な完成画像にしてから、表示Canvasへ全体を一度だけ合成する。
            const baselineLayer = baselineLayerCanvasRef.current ?? document.createElement("canvas");
            const candidateLayer = candidateLayerCanvasRef.current ?? document.createElement("canvas");
            baselineLayerCanvasRef.current = baselineLayer;
            candidateLayerCanvasRef.current = candidateLayer;
            const width = pipelineCanvas.clientWidth;
            const height = pipelineCanvas.clientHeight;
            const baselineIsReference = comparisonMode === "candidate";
            const candidateIsReference = comparisonMode === "baseline";
            const bottomLayer = baselineIsReference ? candidateLayer : baselineLayer;
            const topLayer = baselineIsReference ? baselineLayer : candidateLayer;
            const opacity = comparisonMode === "overlay"
                ? comparisonOpacity
                : COMPARISON_REFERENCE_OPACITY;
            // tileは非同期に完成するので、各layerの更新時にも同じ順序で最終Canvasを再合成する。
            const compose = () => renderer.composePipelineLayers(
                pipelineCanvas, bottomLayer, topLayer, opacity);

            baselineTiledRenderer.drawPipelineSpec(
                baselineTrace,
                currentBaselineSpec,
                baselineLayer,
                {
                    ...baselineTileOptions,
                    width,
                    height,
                    colorScheme: baselineIsReference
                        ? COMPARISON_COLOR_SCHEME.REFERENCE
                        : COMPARISON_COLOR_SCHEME.OVERLAY_BASELINE,
                    referenceOnly: baselineIsReference,
                    onUpdate: compose,
                },
            );
            tiledRenderer.drawPipelineSpec(
                trace,
                candidateSpec,
                candidateLayer,
                {
                    ...candidateTileOptions,
                    width,
                    height,
                    colorScheme: candidateIsReference
                        ? COMPARISON_COLOR_SCHEME.REFERENCE
                        : COMPARISON_COLOR_SCHEME.OVERLAY_CANDIDATE,
                    referenceOnly: candidateIsReference,
                    onUpdate: compose,
                },
            );
            compose();
        }
    }, [
        baselineRenderer,
        baselineTrace,
        comparisonMode,
        comparisonOpacity,
        displayRenderer,
        findResult,
        loadState,
        onRenderedZoomChange,
        renderer,
        tiledRenderer,
        baselineTiledRenderer,
        tiledRenderingEnabled,
        trace,
        webGLEnabled,
    ]);

    const redraw = useCallback(() => {
        const candidateSpec = renderedSpecRef.current;
        const currentBaselineSpec = renderedBaselineSpecRef.current;
        drawSpecs(
            candidateSpec,
            currentBaselineSpec,
            viewTransition === null ? undefined : { ...candidateSpec, ...viewTransition.target },
            viewTransition?.baselineTarget === undefined || currentBaselineSpec === undefined
                ? undefined
                : { ...currentBaselineSpec, ...viewTransition.baselineTarget },
        );
    }, [drawSpecs, viewTransition]);

    useImperativeHandle(ref, () => ({
        clearToolTip: () => setToolTip(null),
        resetPipelineCanvas: resetPipelineCanvases,
        cancelViewTransition,
        scrollTo,
        zoomAt,
        goToView,
        resetView,
        getRenderedSpec: () => renderedSpecRef.current,
        getViewportSize: () => ({
            pipelineWidth: pipelineCanvasRef.current?.clientWidth ?? 800,
            pipelineHeight: pipelineCanvasRef.current?.clientHeight ?? 400,
            labelHeight: labelCanvasRef.current?.clientHeight ?? 400,
        }),
    }), [cancelViewTransition, goToView, resetPipelineCanvases, resetView, scrollTo, zoomAt]);

    useLayoutEffect(() => resetPipelineCanvases, [resetPipelineCanvases]);

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
        if (viewTransition === null) {
            transitionClockRef.current = null;
            return;
        }
        const clock = transitionClockRef.current?.id === viewTransition.id
            ? transitionClockRef.current
            : { id: viewTransition.id, startedAt: performance.now() };
        transitionClockRef.current = clock;
        let frameID = 0;
        let active = true;
        const drawProgress = (progress: number) => {
            const baselineFrom = baselineRenderSpec ?? undefined;
            const baselineTarget = viewTransition.baselineTarget;
            const candidateSpec = interpolateRenderSpec(
                trace,
                renderSpec,
                viewTransition.target,
                viewTransition.motion,
                progress,
            );
            const currentBaselineSpec = baselineFrom === undefined || baselineTarget === undefined
                ? undefined
                : interpolateRenderSpec(
                    baselineTrace,
                    baselineFrom,
                    baselineTarget,
                    viewTransition.motion,
                    progress,
                );
            drawSpecs(
                candidateSpec,
                currentBaselineSpec,
                { ...candidateSpec, ...viewTransition.target },
                currentBaselineSpec === undefined || baselineTarget === undefined
                    ? undefined
                    : { ...currentBaselineSpec, ...baselineTarget },
            );
        };
        const animate = (now: number) => {
            if (!active) {
                return;
            }
            const progress = Math.max(
                0,
                Math.min(1, (now - clock.startedAt) / viewTransition.motion.duration),
            );
            drawProgress(progress);
            if (progress >= 1) {
                transitionClockRef.current = null;
                if (tabID !== null) {
                    onViewAction({
                        type: "KONATA_VIEW_TRANSITION_FINISH",
                        tabID,
                        transitionID: viewTransition.id,
                    });
                }
            }
            else {
                frameID = requestAnimationFrame(animate);
            }
        };

        // 設定変更でeffectが組み直されても同じ時計から再開し、中間SpecはStoreへ書き戻さない。
        animate(performance.now());
        return () => {
            active = false;
            cancelAnimationFrame(frameID);
        };
    }, [
        baselineRenderSpec,
        baselineTrace,
        drawSpecs,
        onViewAction,
        renderSpec,
        tabID,
        trace,
        viewTransition,
    ]);

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
            zoomAt(event.deltaY < 0 ? 1.2 : 1 / 1.2, x, y);
            return;
        }

        if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
            // trackpadの横移動は、旧キーボード横移動と同じ6cycle単位へ対応させる。
            const differenceX = (event.deltaX > 0 ? 1 : -1) *
                6 / displayMetricsRef.current.zoomScale;
            onMoveView([differenceX, 0], false);
            return;
        }

        // 旧wheel操作と同じ3命令単位で移動し、左端を命令のfetch位置へ追従させる。
        const differenceY = (event.deltaY > 0 ? 1 : -1) *
            3 / displayMetricsRef.current.zoomScale;
        onMoveView([0, differenceY], true);
    }, [onMoveView, trace, zoomAt]);

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
        const positions = pointerPositionsRef.current;
        // 3本目以降はgestureへ影響させず、1本panと2本pinchだけを扱う。
        if (positions.size >= 2) {
            return;
        }
        event.currentTarget.setPointerCapture(event.pointerId);
        positions.set(event.pointerId, { x: event.clientX, y: event.clientY });
        setIsPanning(true);
    };

    const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
        const positions = pointerPositionsRef.current;
        const previous = positions.get(event.pointerId);
        if (previous === undefined) {
            return;
        }
        if (positions.size === 1) {
            // 紙を掴む感覚に合わせ、pointer移動と逆向きへviewを進める。
            cancelViewTransition();
            onPanView(previous.x - event.clientX, previous.y - event.clientY);
            positions.set(event.pointerId, { x: event.clientX, y: event.clientY });
            return;
        }

        const previousPair = Array.from(positions.values());
        positions.set(event.pointerId, { x: event.clientX, y: event.clientY });
        const currentPair = Array.from(positions.values());
        const distance = (pair: PointerPosition[]) => Math.hypot(
            pair[0].x - pair[1].x,
            pair[0].y - pair[1].y,
        );
        const previousDistance = distance(previousPair);
        const currentDistance = distance(currentPair);
        if (previousDistance === 0 || currentDistance === 0) {
            return;
        }
        const previousCenter = {
            x: (previousPair[0].x + previousPair[1].x) / 2,
            y: (previousPair[0].y + previousPair[1].y) / 2,
        };
        const currentCenter = {
            x: (currentPair[0].x + currentPair[1].x) / 2,
            y: (currentPair[0].y + currentPair[1].y) / 2,
        };
        const pipelineRect = pipelineCanvasRef.current?.getBoundingClientRect();
        if (pipelineRect === undefined) {
            return;
        }
        const factor = currentDistance / previousDistance;
        // 2点の中心移動もpanとして反映し、指の間にあった位置をzoom後も維持する。
        cancelViewTransition();
        onPinchView(
            previousCenter.x - currentCenter.x,
            previousCenter.y - currentCenter.y,
            // Rendererのscaleは2^-levelなので、距離比を連続したlevel差へ変換する。
            -Math.log2(factor),
            Math.max(0, currentCenter.x - pipelineRect.left),
            Math.max(0, currentCenter.y - pipelineRect.top),
        );
    };

    const handlePointerUp = (event: PointerEvent<HTMLDivElement>) => {
        const positions = pointerPositionsRef.current;
        positions.delete(event.pointerId);
        setIsPanning(positions.size > 0);
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
        }
    };

    const handlePipelineClick = (event: ReactMouseEvent<HTMLDivElement>) => {
        // native dblclickは3回目以降も続くmulti-click中に再発火しないため、偶数clickを各ペアの終端とする。
        // これにより素早い4連打、6連打でもズーム入力を落とさず、既存の目標倍率へ積み上げられる。
        if (trace === null || event.detail % 2 !== 0) {
            return;
        }
        const pipeline = pipelineCanvasRef.current;
        if (pipeline === null) {
            return;
        }
        const rect = pipeline.getBoundingClientRect();
        // panのためviewerがpointer captureを取ると、実clickのtargetはCanvasではなくviewerになる。
        // viewerでclickを受け、labelやsplitter上の操作は座標で除外する。
        if (event.clientX < rect.left || event.clientX >= rect.right ||
            event.clientY < rect.top || event.clientY >= rect.bottom) {
            return;
        }
        zoomAt(
            event.shiftKey ? 1 / 2 : 2,
            event.clientX - rect.left,
            event.clientY - rect.top,
        );
    };

    const handleLabelClick = (event: ReactMouseEvent<HTMLCanvasElement>) => {
        if (trace === null) {
            return;
        }
        const rect = event.currentTarget.getBoundingClientRect();
        const currentMetrics = displayMetricsRef.current;
        const op = currentMetrics.getOpFromPixelPositionY(event.clientY - rect.top);
        if (op !== undefined) {
            // A/B単独表示では、ラベルを選んだ側だけをその命令のfetch cycleへ動かす。
            scrollTo([
                op.fetchedCycle,
                currentMetrics.spec.position[1],
            ]);
        }
    };

    const updateToolTip = (
        pane: "label" | "pipeline",
        event: ReactMouseEvent<HTMLCanvasElement>,
    ) => {
        if (trace === null || pointerPositionsRef.current.size > 0) {
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
        const currentMetrics = displayMetricsRef.current;
        const text = pane === "label"
            ? currentMetrics.getLabelToolTipText(y)
            : currentMetrics.getPipelineToolTipText(x, y);
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
        : Math.floor(metrics.getPixelPositionYFromID(findResult.anchorID)) + metrics.opHeight;

    return (
        <div
            ref={viewerRef}
            className={`viewer${isPanning ? " is-panning" : ""}${isResizing ? " is-resizing" : ""}`}
            style={{
                // trace公開前は操作対象がないためdividerを消し、初期画面を1枚のpaneとして見せる。
                gridTemplateColumns: trace === null
                    ? "0 minmax(0, 1fr)"
                    : `minmax(0, min(${splitterPosition}px, calc(100% - 10px))) 10px minmax(0, 1fr)`,
            }}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerUp}
            onClick={handlePipelineClick}
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
            {trace !== null && (
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
            )}
            <section className="viewer-pane pipeline-pane" aria-label="Pipeline chart">
                <canvas
                    ref={pipelineCanvasRef}
                    className={comparison === null ? undefined : "comparison-result-canvas"}
                    aria-label="Pipeline canvas"
                    onMouseMove={(event) => updateToolTip("pipeline", event)}
                    onMouseLeave={() => setToolTip(null)}
                >
                    The pipeline chart requires canvas support.
                </canvas>
            </section>
            {trace === null && loadState !== "loading" && (
                <div className="empty-state">
                    <strong>{loadState === "error" ? "The trace could not be opened." : "Drop one or more Kanata or gem5 O3PipeView traces anywhere in this window."}</strong>
                    <span>{loadState === "error" ? errorMessage : "Plain text, gzip, and Zstandard files are supported."}</span>
                    {loadState === "error" && (
                        <button type="button" onClick={onOpenTrace}>Choose another trace</button>
                    )}
                    <small
                        className="build-info"
                        data-version={__KONATA_VERSION__}
                        data-commit={__KONATA_COMMIT__}
                        data-date={__KONATA_COMMIT_DATE__}
                    >
                        Version {__KONATA_VERSION__} · Commit {__KONATA_COMMIT__} · {__KONATA_COMMIT_DATE__}
                    </small>
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
                    ref={findResultRef}
                    className="find-result"
                    data-op-id={findResult.opID}
                    style={{ top: findResultTop }}
                    onPointerDown={(event) => event.stopPropagation()}
                >
                    <div className="find-result-content">
                        {renderSpec.hideFlushedOps && findResult.flushed && (
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
                    <button type="button" aria-label="Close search result" title="Close" onClick={onCloseFindResult}>
                        <BsX aria-hidden="true" />
                    </button>
                </div>
            )}
        </div>
    );
});
