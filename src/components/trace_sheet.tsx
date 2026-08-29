import {
    type CSSProperties,
    forwardRef,
    type MouseEvent as ReactMouseEvent,
    type PointerEvent,
    useCallback,
    useEffect,
    useImperativeHandle,
    useLayoutEffect,
    useRef,
    useState,
} from "react";
import { BsX } from "react-icons/bs";

import type { ParsedTrace } from "../core/model";
import {
    buildTopDownData,
    TOP_DOWN_INITIAL_SNAPSHOT_OP_COUNT,
    type TopDownData,
    updateTopDownData,
} from "../core/top_down_analysis";
import {
    drawCycleNavigator,
    getCycleActivityAtPixel,
    getTopDownBreakdownAtPixel,
    type CycleNavigatorMode,
} from "../core/trace_navigator_renderer";
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
import {
    KonataViewController,
    type KonataViewFrame,
    type KonataViewMotion,
} from "../core/konata_view_controller";
import type {
    ComparisonMode,
    FindResult,
    LoadState,
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
const WHEEL_ZOOM_AGGREGATION_MS = 40;
const WHEEL_LINE_DELTA = 40;
const WHEEL_PAGE_DELTA = 300;
const WHEEL_DELTA_PER_ZOOM_LEVEL = 120;
const MAX_WHEEL_ZOOM_LEVELS = 2;
const TRACKPAD_DELTA_PER_ZOOM_LEVEL = 100;
const MAX_TRACKPAD_ZOOM_PER_FRAME = 0.25;
const MIN_TRACE_NAVIGATOR_HEIGHT = 64;
const MIN_PIPELINE_HEIGHT = 96;

function normalizeWheelDelta(event: WheelEvent): number {
    // deltaの単位はdevice／OS依存なので、主要map rendererと同じ尺度へ先に揃える。
    if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) {
        return event.deltaY * WHEEL_LINE_DELTA;
    }
    if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) {
        return event.deltaY * WHEEL_PAGE_DELTA;
    }
    return event.deltaY;
}

export interface TraceSheetHandle {
    clearToolTip(): void;
    resetPipelineCanvas(): void;
    finishViewTransition(): void;
    scrollTo(
        position: readonly [number, number],
        baselinePosition?: readonly [number, number],
    ): void;
    zoomAt(factor: number, centerX: number, centerY: number): void;
    moveView(difference: readonly [number, number], adjustHorizontal: boolean): void;
    goToView(view: KonataView): void;
    resetView(): void;
    getViewportSize(): {
        readonly pipelineWidth: number;
        readonly pipelineHeight: number;
        readonly labelHeight: number;
    };
}

interface TraceSheetProps {
    readonly trace: ParsedTrace | null;
    readonly renderSpec: Readonly<KonataRenderSpec>;
    readonly loadState: LoadState;
    readonly errorMessage: string;
    readonly renderVersion: number;
    readonly webGLEnabled: boolean;
    readonly tiledRenderingEnabled: boolean;
    readonly traceNavigatorVisible: boolean;
    readonly zoomStep: number;
    readonly findResult: FindResult | null;
    readonly comparison: {
        readonly baselineTrace: ParsedTrace | null;
        readonly baselineRenderSpec: Readonly<KonataRenderSpec>;
        readonly mode: ComparisonMode;
        readonly opacity: number;
    } | null;
    readonly splitterPosition: number;
    readonly onMoveSplitter: (position: number) => void;
    readonly onSetView: (view: KonataView, baselineView?: KonataView) => void;
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

// 旧app_sheetに相当し、label/pipeline Canvasとその直接操作を同じ単位で所有する。
export const TraceSheet = forwardRef<TraceSheetHandle, TraceSheetProps>(function TraceSheet({
    trace,
    renderSpec,
    loadState,
    errorMessage,
    renderVersion,
    webGLEnabled,
    tiledRenderingEnabled,
    traceNavigatorVisible,
    zoomStep,
    findResult,
    comparison,
    splitterPosition,
    onMoveSplitter,
    onSetView,
    onCloseFindResult,
    onOpenTrace,
}, ref) {
    const viewerRef = useRef<HTMLDivElement>(null);
    const labelCanvasRef = useRef<HTMLCanvasElement>(null);
    const pipelineCanvasRef = useRef<HTMLCanvasElement>(null);
    const cycleNavigatorLabelCanvasRef = useRef<HTMLCanvasElement>(null);
    const cycleNavigatorCanvasRef = useRef<HTMLCanvasElement>(null);
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
    const baselineRenderSpec = comparison?.baselineRenderSpec;
    const drawFrameRef = useRef<(frame: Readonly<KonataViewFrame>) => void>(() => undefined);
    const setViewRef = useRef(onSetView);
    setViewRef.current = onSetView;
    const viewControllerRef = useRef<KonataViewController | null>(null);
    if (viewControllerRef.current === null) {
        viewControllerRef.current = new KonataViewController(
            {
                trace,
                targetSpec: renderSpec,
                baselineTrace,
                baselineTargetSpec: baselineRenderSpec,
            },
            (frame) => drawFrameRef.current(frame),
            (view, baselineView) => setViewRef.current(view, baselineView),
        );
    }
    const viewController = viewControllerRef.current;
    const metrics = new KonataRenderMetrics(trace, viewController.currentSpec);
    const baselineMetrics = baselineRenderSpec === undefined
        ? null
        : new KonataRenderMetrics(baselineTrace, baselineRenderSpec);
    const pointerPositionsRef = useRef(new Map<number, PointerPosition>());
    const splitterPointerIDRef = useRef<number | null>(null);
    const traceNavigatorResizerPointerIDRef = useRef<number | null>(null);
    const wheelZoomRef = useRef({
        modifierDown: false,
        trackpadDelta: 0,
        centerX: 0,
        centerY: 0,
        frameID: null as number | null,
        wheelDelta: 0,
        wheelTimerID: null as number | null,
    });
    const [isPanning, setIsPanning] = useState(false);
    const [isResizing, setIsResizing] = useState(false);
    const [isTraceNavigatorResizing, setIsTraceNavigatorResizing] = useState(false);
    const [traceNavigatorHeight, setTraceNavigatorHeight] = useState<number | null>(null);
    const [cycleNavigatorMode, setCycleNavigatorMode] =
        useState<CycleNavigatorMode>("top-down");
    const [toolTip, setToolTip] = useState<CanvasToolTip | null>(null);
    // UI／制御層は集計結果の寿命だけを所有する。TopDownDataはTraceから
    // 再構築できる派生dataなのでStoreへ入れず、表示中のTraceSheet内に留める。
    const [topDownData, setTopDownData] = useState<TopDownData | null>(null);
    const topDownLiveDataRef = useRef<{
        readonly trace: ParsedTrace;
        data: TopDownData;
    } | null>(null);
    const [topDownError, setTopDownError] = useState(false);
    const comparisonMode = comparison?.mode ?? null;
    const comparisonOpacity = comparison?.opacity ?? 1;
    const showTraceNavigator = traceNavigatorVisible && comparison === null &&
        trace !== null;
    const topDownSampleReady = trace !== null && (loadState === "ready" ||
        trace.opCount >= TOP_DOWN_INITIAL_SNAPSHOT_OP_COUNT);
    const topDownStatusMessage = topDownError
        ? "Trace navigator analysis unavailable"
        : !topDownSampleReady
            ? `Collecting pipeline sample… ${(trace?.opCount ?? 0).toLocaleString()} / ${TOP_DOWN_INITIAL_SNAPSHOT_OP_COUNT.toLocaleString()} ops`
            : "Building trace navigator analysis…";
    // A単独表示だけはラベルとマウス参照もAへ切り替え、それ以外はBを前面の情報源にする。
    const displayRenderer = comparisonMode === "baseline" && baselineRenderer !== null
        ? baselineRenderer
        : renderer;
    const displayMetrics = comparisonMode === "baseline" && baselineMetrics !== null
        ? baselineMetrics
        : metrics;
    const displayMetricsRef = useRef(displayMetrics);
    displayMetricsRef.current = displayMetrics;

    const startViewTransition = useCallback((
        target: KonataView,
        baselineTarget: KonataView | undefined,
        motion: Readonly<KonataViewMotion>,
    ) => {
        setToolTip(null);
        viewController.transitionTo(target, baselineTarget, motion);
    }, [viewController]);

    const finishViewTransition = useCallback(() => {
        viewController.finish();
    }, [viewController]);

    const scrollTo = useCallback((
        position: readonly [number, number],
        baselinePosition?: readonly [number, number],
    ) => {
        const from = viewController.currentSpec;
        const baselineFrom = viewController.currentBaselineSpec;
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
    }, [comparisonMode, startViewTransition, viewController]);

    const moveView = useCallback((
        difference: readonly [number, number],
        adjustHorizontal: boolean,
    ) => {
        const candidateTarget = viewController.targetSpec;
        const baselineTarget = viewController.baselineTargetSpec;
        // 縦移動では画面中央に見えている実行位置を基準にする。Canvas寸法は描画Specへ
        // 保存せず、この操作中の座標変換にだけ使用する。
        const horizontalAnchorPixel = (pipelineCanvasRef.current?.clientWidth ?? 0) / 2;
        const applyCandidate = comparisonMode !== "baseline";
        const applyBaseline = baselineTarget !== undefined && comparisonMode !== "candidate";
        const nextCandidate = applyCandidate
            ? new KonataRenderMetrics(trace, candidateTarget).withLogicalDifference(
                difference,
                adjustHorizontal,
                horizontalAnchorPixel,
            )
            : candidateTarget;
        const nextBaseline = baselineTarget === undefined
            ? undefined
            : applyBaseline
                ? new KonataRenderMetrics(baselineTrace, baselineTarget).withLogicalDifference(
                    difference,
                    adjustHorizontal,
                    horizontalAnchorPixel,
                )
                : baselineTarget;
        startViewTransition(
            getKonataView(nextCandidate),
            nextBaseline === undefined ? undefined : getKonataView(nextBaseline),
            { type: "linear", duration: SCROLL_ANIMATION_DURATION },
        );
    }, [baselineTrace, comparisonMode, startViewTransition, trace, viewController]);

    const zoomAt = useCallback((factor: number, centerX: number, centerY: number, steps = 1) => {
        if (factor === 1) {
            return;
        }
        const from = viewController.currentSpec;
        const baselineFrom = viewController.currentBaselineSpec;
        const baseLevel = viewController.targetSpec.zoomLevel;
        const zoomLevel = clampKonataZoomLevel(
            baseLevel + (factor > 1 ? -zoomStep : zoomStep) * steps,
        );
        // 上限でのkey repeatは同じ終点へのanimationを再起動せず、進行中の最後の遷移を完了させる。
        if (zoomLevel === baseLevel) {
            return;
        }
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
    }, [baselineTrace, startViewTransition, trace, viewController, zoomStep]);

    const zoomImmediatelyBy = useCallback((
        difference: number,
        centerX: number,
        centerY: number,
        panX = 0,
        panY = 0,
    ) => {
        const from = viewController.currentSpec;
        const baselineFrom = viewController.currentBaselineSpec;
        const applyZoom = (
            currentTrace: ParsedTrace | null,
            spec: Readonly<KonataRenderSpec>,
        ) => {
            const panned = new KonataRenderMetrics(currentTrace, spec).withPixelPan(panX, panY);
            return getKonataView(new KonataRenderMetrics(currentTrace, panned).withZoomLevel(
                panned.zoomLevel + difference, centerX, centerY,
            ));
        };
        viewController.setImmediately(
            applyZoom(trace, from),
            baselineFrom === undefined ? undefined : applyZoom(baselineTrace, baselineFrom),
        );
    }, [baselineTrace, trace, viewController]);

    const transitionToView = useCallback((
        target: KonataView,
        motion: Readonly<KonataViewMotion>,
    ) => {
        const from = viewController.currentSpec;
        const baselineFrom = viewController.currentBaselineSpec;
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
    }, [startViewTransition, viewController]);

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
            cycleNavigatorLabelCanvasRef.current,
            cycleNavigatorCanvasRef.current,
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
        const cycleNavigatorLabelCanvas = cycleNavigatorLabelCanvasRef.current;
        const cycleNavigatorCanvas = cycleNavigatorCanvasRef.current;
        const candidateMetrics = new KonataRenderMetrics(trace, candidateSpec);
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
        if (showTraceNavigator && topDownData !== null &&
            cycleNavigatorLabelCanvas !== null && cycleNavigatorCanvas !== null) {
            drawCycleNavigator(
                topDownData,
                candidateSpec,
                cycleNavigatorLabelCanvas,
                cycleNavigatorCanvas,
                cycleNavigatorMode,
            );
        }
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
        cycleNavigatorMode,
        displayRenderer,
        findResult,
        loadState,
        renderer,
        showTraceNavigator,
        topDownData,
        tiledRenderer,
        baselineTiledRenderer,
        tiledRenderingEnabled,
        trace,
        webGLEnabled,
    ]);

    drawFrameRef.current = (frame) => drawSpecs(
        frame.spec,
        frame.baselineSpec,
        frame.prefetchSpec,
        frame.baselinePrefetchSpec,
    );

    const redraw = useCallback(() => {
        viewController.redraw();
    }, [viewController]);

    // Traceまたはpaneを切り替えた時は、以前のTraceから作った派生dataを外す。
    useEffect(() => {
        topDownLiveDataRef.current = null;
        setTopDownData(null);
        setTopDownError(false);
    }, [showTraceNavigator, trace]);

    // 読み込み中は最初の50k命令で構造を決め、完了時だけ末尾まで再解析する。
    // zoomやthemeの変更は下のuseLayoutEffectから同じTopDownDataを再描画する。
    useEffect(() => {
        let canceled = false;
        if (!showTraceNavigator || trace === null || !topDownSampleReady) {
            return () => {
                canceled = true;
            };
        }
        setTopDownError(false);

        void buildTopDownData(trace, {
            isCanceled: () => canceled,
            live: loadState !== "ready",
        })
            .then((data) => {
                if (!canceled && data !== null) {
                    if (data.analysis === null) {
                        topDownLiveDataRef.current = null;
                        setTopDownData(data);
                        return;
                    }
                    // 全体解析中にParserが公開した分も、最初の表示へまとめて追記する。
                    const currentData = updateTopDownData(data, trace);
                    topDownLiveDataRef.current = { trace, data: currentData };
                    setTopDownData(currentData);
                }
            })
            .catch((error: unknown) => {
                if (!canceled) {
                    console.warn("Could not build trace navigator analysis.", error);
                    setTopDownError(true);
                }
            });
        return () => {
            canceled = true;
        };
    }, [loadState, showTraceNavigator, topDownSampleReady, trace]);

    // Pipelineと同じ途中Traceの公開通知ごとに、節目間の差分だけをNavigatorへ反映する。
    useEffect(() => {
        const live = topDownLiveDataRef.current;
        if (!showTraceNavigator || trace === null || live?.trace !== trace) {
            return;
        }
        const data = updateTopDownData(live.data, trace);
        live.data = data;
        setTopDownData((current) => current === data ? current : data);
    }, [renderVersion, showTraceNavigator, trace]);

    useLayoutEffect(() => {
        if (showTraceNavigator && topDownData !== null) {
            redraw();
        }
    }, [cycleNavigatorMode, redraw, showTraceNavigator, topDownData]);

    useLayoutEffect(() => {
        if (traceNavigatorHeight !== null) {
            // viewer外形は変わらないため、子paneのrow変更後は明示的にCanvasを再描画する。
            redraw();
        }
    }, [redraw, traceNavigatorHeight]);

    useImperativeHandle(ref, () => ({
        clearToolTip: () => setToolTip(null),
        resetPipelineCanvas: resetPipelineCanvases,
        finishViewTransition,
        scrollTo,
        moveView,
        zoomAt,
        goToView,
        resetView,
        getViewportSize: () => ({
            pipelineWidth: pipelineCanvasRef.current?.clientWidth ?? 800,
            pipelineHeight: pipelineCanvasRef.current?.clientHeight ?? 400,
            labelHeight: labelCanvasRef.current?.clientHeight ?? 400,
        }),
    }), [finishViewTransition, goToView, moveView, resetPipelineCanvases, resetView, scrollTo, zoomAt]);

    useLayoutEffect(() => () => {
        viewController.dispose();
        resetPipelineCanvases();
    }, [resetPipelineCanvases, viewController]);

    useLayoutEffect(() => {
        viewController.sync({
            trace,
            targetSpec: renderSpec,
            baselineTrace,
            baselineTargetSpec: baselineRenderSpec,
        });
    }, [baselineRenderSpec, baselineTrace, renderSpec, renderVersion, trace, viewController]);

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

    const moveSplitterFromPointer = (clientX: number) => {
        const viewer = viewerRef.current;
        if (viewer === null) {
            return;
        }
        const rect = viewer.getBoundingClientRect();
        // 保存値は画面幅と独立させ、狭い画面での表示上限はCSSだけで適用する。
        const position = Math.min(Math.max(clientX - rect.left, 0), Math.max(0, rect.width - 10));
        onMoveSplitter(position);
    };

    const handleSplitterPointerDown = (event: PointerEvent<HTMLDivElement>) => {
        if (event.button !== 0 || splitterPointerIDRef.current !== null) {
            return;
        }
        splitterPointerIDRef.current = event.pointerId;
        event.currentTarget.setPointerCapture(event.pointerId);
        setIsResizing(true);
        event.preventDefault();
        event.stopPropagation();
    };

    const handleSplitterPointerMove = (event: PointerEvent<HTMLDivElement>) => {
        if (splitterPointerIDRef.current !== event.pointerId) {
            return;
        }
        moveSplitterFromPointer(event.clientX);
        event.preventDefault();
        event.stopPropagation();
    };

    const handleSplitterPointerUp = (event: PointerEvent<HTMLDivElement>) => {
        if (splitterPointerIDRef.current !== event.pointerId) {
            return;
        }
        splitterPointerIDRef.current = null;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
        }
        setIsResizing(false);
        event.preventDefault();
        event.stopPropagation();
    };

    const moveTraceNavigatorResizerFromPointer = (clientY: number) => {
        const viewer = viewerRef.current;
        if (viewer === null) {
            return;
        }
        const rect = viewer.getBoundingClientRect();
        const maxHeight = Math.max(0, rect.height - MIN_PIPELINE_HEIGHT);
        const minHeight = Math.min(MIN_TRACE_NAVIGATOR_HEIGHT, maxHeight);
        setTraceNavigatorHeight(Math.round(Math.min(
            Math.max(rect.bottom - clientY, minHeight),
            maxHeight,
        )));
    };

    const handleTraceNavigatorResizerPointerDown = (event: PointerEvent<HTMLDivElement>) => {
        if (event.button !== 0 || traceNavigatorResizerPointerIDRef.current !== null) {
            return;
        }
        traceNavigatorResizerPointerIDRef.current = event.pointerId;
        event.currentTarget.setPointerCapture(event.pointerId);
        setIsTraceNavigatorResizing(true);
        event.preventDefault();
        event.stopPropagation();
    };

    const handleTraceNavigatorResizerPointerMove = (event: PointerEvent<HTMLDivElement>) => {
        if (traceNavigatorResizerPointerIDRef.current !== event.pointerId) {
            return;
        }
        moveTraceNavigatorResizerFromPointer(event.clientY);
        event.preventDefault();
        event.stopPropagation();
    };

    const handleTraceNavigatorResizerPointerUp = (event: PointerEvent<HTMLDivElement>) => {
        if (traceNavigatorResizerPointerIDRef.current !== event.pointerId) {
            return;
        }
        traceNavigatorResizerPointerIDRef.current = null;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
        }
        setIsTraceNavigatorResizing(false);
        event.preventDefault();
        event.stopPropagation();
    };

    const handleWheel = useCallback((event: WheelEvent) => {
        if (trace === null) {
            return;
        }
        const target = event.target as HTMLElement | null;
        if (target?.closest(".trace-navigator-pane, .trace-navigator-resizer")) {
            return;
        }
        event.preventDefault();
        if (event.ctrlKey || event.metaKey) {
            const rect = pipelineCanvasRef.current?.getBoundingClientRect();
            const x = rect === undefined ? 0 : Math.max(0, event.clientX - rect.left);
            const y = rect === undefined ? 0 : Math.max(0, event.clientY - rect.top);
            const delta = normalizeWheelDelta(event);
            if (delta === 0) {
                return;
            }
            const wheelZoom = wheelZoomRef.current;
            if (!wheelZoom.modifierDown) {
                wheelZoom.trackpadDelta += delta;
                wheelZoom.centerX = x;
                wheelZoom.centerY = y;
                if (wheelZoom.frameID === null) {
                    // Chromiumのpinchは高頻度なCtrl+wheelになるため、1 frameへまとめて小数倍率で追従する。
                    wheelZoom.frameID = requestAnimationFrame(() => {
                        wheelZoom.frameID = null;
                        const difference = Math.max(
                            -MAX_TRACKPAD_ZOOM_PER_FRAME,
                            Math.min(
                                MAX_TRACKPAD_ZOOM_PER_FRAME,
                                wheelZoom.trackpadDelta / TRACKPAD_DELTA_PER_ZOOM_LEVEL * zoomStep,
                            ),
                        );
                        wheelZoom.trackpadDelta = 0;
                        zoomImmediatelyBy(difference, wheelZoom.centerX, wheelZoom.centerY);
                    });
                }
                return;
            }

            wheelZoom.wheelDelta += delta;
            wheelZoom.centerX = x;
            wheelZoom.centerY = y;
            if (wheelZoom.wheelTimerID === null) {
                // 物理wheelは40 ms分を1操作へ畳み、通常1段、高速回転でも最大2段に抑える。
                wheelZoom.wheelTimerID = window.setTimeout(() => {
                    wheelZoom.wheelTimerID = null;
                    const accumulated = wheelZoom.wheelDelta;
                    wheelZoom.wheelDelta = 0;
                    if (accumulated === 0) {
                        return;
                    }
                    const steps = Math.min(
                        MAX_WHEEL_ZOOM_LEVELS,
                        Math.ceil(Math.abs(accumulated) / WHEEL_DELTA_PER_ZOOM_LEVEL),
                    );
                    zoomAt(
                        accumulated < 0 ? 1.2 : 1 / 1.2,
                        wheelZoom.centerX,
                        wheelZoom.centerY,
                        steps,
                    );
                }, WHEEL_ZOOM_AGGREGATION_MS);
            }
            return;
        }

        if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
            // trackpadの横移動は、旧キーボード横移動と同じ6cycle単位へ対応させる。
            const differenceX = (event.deltaX > 0 ? 1 : -1) *
                6 / displayMetricsRef.current.zoomScale;
            moveView([differenceX, 0], false);
            return;
        }

        // 旧wheel操作と同じ3命令単位で移動し、左端を命令のfetch位置へ追従させる。
        const differenceY = (event.deltaY > 0 ? 1 : -1) *
            3 / displayMetricsRef.current.zoomScale;
        moveView([0, differenceY], true);
    }, [moveView, trace, zoomAt, zoomImmediatelyBy, zoomStep]);

    useLayoutEffect(() => {
        const viewer = viewerRef.current;
        if (viewer === null) {
            return;
        }
        const handleModifierKey = (event: KeyboardEvent) => {
            if (event.key === "Control" || event.key === "Meta") {
                wheelZoomRef.current.modifierDown = event.type === "keydown";
            }
        };
        const clearModifierKey = () => {
            wheelZoomRef.current.modifierDown = false;
        };
        // Reactのpassiveなwheel委譲ではCtrl+wheelのbrowser zoomを止められないため、ここだけ直接購読する。
        viewer.addEventListener("wheel", handleWheel, { passive: false });
        document.addEventListener("keydown", handleModifierKey);
        document.addEventListener("keyup", handleModifierKey);
        window.addEventListener("blur", clearModifierKey);
        return () => {
            viewer.removeEventListener("wheel", handleWheel);
            document.removeEventListener("keydown", handleModifierKey);
            document.removeEventListener("keyup", handleModifierKey);
            window.removeEventListener("blur", clearModifierKey);
            const wheelZoom = wheelZoomRef.current;
            if (wheelZoom.frameID !== null) {
                cancelAnimationFrame(wheelZoom.frameID);
                wheelZoom.frameID = null;
            }
            if (wheelZoom.wheelTimerID !== null) {
                clearTimeout(wheelZoom.wheelTimerID);
                wheelZoom.wheelTimerID = null;
            }
            wheelZoom.trackpadDelta = 0;
            wheelZoom.wheelDelta = 0;
        };
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
            setToolTip(null);
            const currentSpec = viewController.currentSpec;
            const currentBaselineSpec = viewController.currentBaselineSpec;
            const applyCandidate = comparisonMode !== "baseline";
            const applyBaseline = currentBaselineSpec !== undefined && comparisonMode !== "candidate";
            const pan = (
                currentTrace: ParsedTrace | null,
                currentSpec: Readonly<KonataRenderSpec>,
            ) => getKonataView(new KonataRenderMetrics(currentTrace, currentSpec).withPixelPan(
                previous.x - event.clientX,
                previous.y - event.clientY,
            ));
            viewController.setImmediately(
                applyCandidate ? pan(trace, currentSpec) : getKonataView(currentSpec),
                currentBaselineSpec === undefined
                    ? undefined
                    : applyBaseline
                        ? pan(baselineTrace, currentBaselineSpec)
                        : getKonataView(currentBaselineSpec),
            );
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
        // 2点の中心移動もpanとして反映し、指の間にあった位置をzoom後も維持する。
        setToolTip(null);
        const panDeltaX = previousCenter.x - currentCenter.x;
        const panDeltaY = previousCenter.y - currentCenter.y;
        const zoomDifference = -Math.log2(currentDistance / previousDistance);
        const centerX = Math.max(0, currentCenter.x - pipelineRect.left);
        const centerY = Math.max(0, currentCenter.y - pipelineRect.top);
        zoomImmediatelyBy(zoomDifference, centerX, centerY, panDeltaX, panDeltaY);
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
        pane: "label" | "pipeline" | "navigator",
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
        let text: string | null;
        if (pane === "navigator") {
            const data = topDownData;
            if (data !== null && cycleNavigatorMode === "top-down") {
                const sample = getTopDownBreakdownAtPixel(
                    data,
                    viewController.currentSpec,
                    x,
                    event.currentTarget.clientWidth,
                );
                if (sample === null) {
                    text = null;
                } else {
                    const format = (value: number) => value.toFixed(0);
                    const percent = (value: number) => sample.totalSlots === 0
                        ? "0.0"
                        : (value / sample.totalSlots * 100).toFixed(1);
                    const admissionRows = sample.analysis.admissionStages.map((admission) =>
                        `${admission.stage.label} → ${sample.analysis.allocationStage.label}: ` +
                        `${format(admission.typicalLatency)} cycles usual`);
                    const recovery = sample.analysis.minimumRecoveryCycles === null
                        ? "minimum recovery unavailable"
                        : `minimum recovery ${format(sample.analysis.minimumRecoveryCycles)} cycles ` +
                            `(${sample.analysis.minimumRecoverySampleCount} samples)`;
                    const representedSlots = (sample.endCycle - sample.startCycle) *
                        sample.analysis.allocationWidth;
                    const observedSlots = sample.samplingStride === 1
                        ? `Observed slots: ${format(sample.totalSlots)}`
                        : `Sampled slots: ${format(sample.totalSlots)} of ` +
                            `${format(representedSlots)} (every ${sample.samplingStride} cycles)`;
                    text = [
                        `Top-down-like (auto allocation: ${sample.analysis.allocationStage.label}, before ${sample.analysis.executionStage.label})`,
                        ...admissionRows.map((label) => `Allocation entrance: ${label}`),
                        `Cycles: ${sample.startCycle}–${sample.endCycle - 1}`,
                        `${observedSlots} (allocation width ≥${format(sample.analysis.allocationWidth)}/cycle)`,
                        `Retiring: ${format(sample.retiringSlots)} (${percent(sample.retiringSlots)}%)`,
                        `Bad speculation (allocated & squashed): ${format(sample.squashedSlots)} (${percent(sample.squashedSlots)}%)`,
                        `Bad speculation (recovery bubbles): ${format(sample.recoveryBubbleSlots)} (${percent(sample.recoveryBubbleSlots)}%)`,
                        `Recovery windows: ${sample.analysis.recoveryWindowCount}; ${recovery}`,
                        `Frontend bound: ${format(sample.frontendBound)} (${percent(sample.frontendBound)}%)`,
                        `Backend bound: ${format(sample.backendBound)} (${percent(sample.backendBound)}%)`,
                        `Unresolved allocation: ${format(sample.unresolvedSlots)} (${percent(sample.unresolvedSlots)}%)`,
                        "All ops are analyzed; zoomed-out values are sampled.",
                    ].join("\n");
                }
            } else if (data !== null && cycleNavigatorMode !== "top-down") {
                const sample = getCycleActivityAtPixel(
                    data,
                    cycleNavigatorMode,
                    viewController.currentSpec,
                    x,
                    event.currentTarget.clientWidth,
                );
                if (sample === null) {
                    text = null;
                } else {
                    const titles = {
                        fetch: "Fetch throughput",
                        issue: `Issue throughput (${data.analysis?.executionStage.label ?? "Issue"})`,
                        commit: "Commit throughput (retired ops)",
                        flush: "Flushed work (at allocation)",
                        latency: "Issue-to-completion latency",
                    } as const;
                    const latency = cycleNavigatorMode === "latency";
                    const unit = latency ? " cycles" : " ops/cycle";
                    text = [
                        titles[cycleNavigatorMode],
                        `Cycles: ${sample.startCycle}–${sample.endCycle - 1}`,
                        `Average: ${sample.average.toFixed(2)}${unit}`,
                        ...(sample.flushedAverage === 0
                            ? []
                            : [`Later flushed: ${sample.flushedAverage.toFixed(2)} ops/cycle`]),
                        `Sampled peak: ${sample.peak}${unit}; observed trace maximum: ${sample.maximum}${unit}`,
                        sample.samplingStride === 1
                            ? `Observed cycles: ${sample.sampledCycleCount}`
                            : `Sampled cycles: ${sample.sampledCycleCount} (every ${sample.samplingStride} cycles)`,
                        ...(latency ? [] : ["Ops/cycle is not necessarily architectural IPC."]),
                    ].join("\n");
                }
            } else {
                text = null;
            }
        } else {
            text = pane === "label"
                ? currentMetrics.getLabelToolTipText(y)
                : currentMetrics.getPipelineToolTipText(x, y);
        }
        setToolTip(text === null ? null : {
            left: event.clientX - viewerRect.left,
            top: pane === "navigator"
                ? Math.max(0, event.clientY - viewerRect.top - 215)
                : event.clientY - viewerRect.top + 20,
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
            className={`viewer${trace === null ? " is-empty" : ""}${showTraceNavigator ? " has-trace-navigator" : ""}${isPanning ? " is-panning" : ""}${isResizing ? " is-resizing" : ""}${isTraceNavigatorResizing ? " is-resizing-trace-navigator" : ""}`}
            // 保存したdesktop幅を維持したまま、狭い画面ではCSS側だけで表示幅を制限する。
            style={{
                "--label-pane-width": `${splitterPosition}px`,
                ...(traceNavigatorHeight === null
                    ? {}
                    : { "--trace-navigator-height": `${traceNavigatorHeight}px` }),
            } as CSSProperties}
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
                    onPointerDown={handleSplitterPointerDown}
                    onPointerMove={handleSplitterPointerMove}
                    onPointerUp={handleSplitterPointerUp}
                    onPointerCancel={handleSplitterPointerUp}
                    onLostPointerCapture={handleSplitterPointerUp}
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
            {showTraceNavigator && (
                <>
                    <div
                        className="trace-navigator-resizer"
                        role="separator"
                        aria-label="Resize trace navigator"
                        aria-orientation="horizontal"
                        aria-valuemin={MIN_TRACE_NAVIGATOR_HEIGHT}
                        aria-valuenow={traceNavigatorHeight ?? undefined}
                        onClick={(event) => event.stopPropagation()}
                        onPointerDown={handleTraceNavigatorResizerPointerDown}
                        onPointerMove={handleTraceNavigatorResizerPointerMove}
                        onPointerUp={handleTraceNavigatorResizerPointerUp}
                        onPointerCancel={handleTraceNavigatorResizerPointerUp}
                        onLostPointerCapture={handleTraceNavigatorResizerPointerUp}
                    />
                    <section
                        className="viewer-pane trace-navigator-pane trace-navigator-cycle-label-pane"
                        aria-label="Cycle navigator labels"
                        onPointerDown={(event) => event.stopPropagation()}
                    >
                        <canvas ref={cycleNavigatorLabelCanvasRef} aria-label="Cycle navigator labels canvas" />
                        <select
                            className="trace-navigator-mode"
                            aria-label="Cycle navigator mode"
                            value={cycleNavigatorMode}
                            onChange={(event) => setCycleNavigatorMode(
                                event.currentTarget.value as CycleNavigatorMode,
                            )}
                        >
                            <option value="top-down">Top-down</option>
                            <option value="fetch">Fetch</option>
                            <option value="issue">Issue</option>
                            <option value="commit">Commit</option>
                            <option value="flush">Flush</option>
                            <option value="latency">Latency</option>
                        </select>
                    </section>
                    <div className="trace-navigator-cycle-divider" aria-hidden="true" />
                    <section
                        className="viewer-pane trace-navigator-pane trace-navigator-cycle-pane"
                        aria-label="Cycle navigator"
                        onPointerDown={(event) => event.stopPropagation()}
                    >
                        <canvas
                            ref={cycleNavigatorCanvasRef}
                            aria-label="Cycle navigator canvas"
                            onMouseMove={(event) => updateToolTip("navigator", event)}
                            onMouseLeave={() => setToolTip(null)}
                        />
                        {topDownData === null && (
                            <span className="trace-navigator-cycle-status">
                                {topDownStatusMessage}
                            </span>
                        )}
                    </section>
                </>
            )}
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
