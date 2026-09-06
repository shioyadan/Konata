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
    buildCycleNavigatorData,
    CYCLE_NAVIGATOR_INITIAL_SNAPSHOT_OP_COUNT,
    resolveCycleNavigatorMode,
    type CycleNavigatorData,
    type CycleNavigatorMode,
    updateCycleNavigatorData,
} from "../core/trace_navigator_analysis";
import {
    drawComparisonInstructionNavigator,
    drawComparisonCycleNavigator,
    drawCycleNavigator,
    drawInstructionNavigator,
    getComparisonCycleNavigatorScrollPosition,
    getComparisonCycleNavigatorViewport,
    getCycleNavigatorScrollPosition,
    getCycleNavigatorViewport,
    getInstructionNavigatorPosition,
    type CycleNavigatorComparison,
    type CycleNavigatorComparisonTrack,
} from "../core/trace_navigator_renderer";
import {
    COMPARISON_COLOR_SCHEME,
    clampKonataZoomLevel,
    getKonataView,
    KonataRenderMetrics,
    KonataRenderer,
    moveSynchronizedRenderSpecs,
    type KonataRenderSpec,
    type KonataView,
} from "../core/konata_renderer";
import { TiledPipelineRenderer } from "../core/tiled_pipeline_renderer";
import {
    KonataViewController,
    type KonataViewFrame,
    type KonataViewMotion,
} from "../core/konata_view_controller";
import {
    MIN_TRACE_NAVIGATOR_HEIGHT,
    MIN_INSTRUCTION_NAVIGATOR_WIDTH,
    type ComparisonMode,
    type FindResult,
    type LoadState,
    type TraceNavigatorSettings,
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

type NavigatorAxis = "cycle" | "instruction";

interface CanvasToolTip {
    readonly left: number;
    readonly top: number;
    readonly text: string;
    readonly bottomBoundary?: number;
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
const MIN_PIPELINE_HEIGHT = 96;
const COMPACT_TRACE_NAVIGATOR_HEIGHT = 22;
const TOOLTIP_BELOW_POINTER_OFFSET = 20;
const TOOLTIP_ABOVE_POINTER_GAP = 8;

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

function createCycleNavigatorComparison(
    baselineData: Readonly<CycleNavigatorData> | null,
    candidateData: Readonly<CycleNavigatorData>,
    baselineSpec: Readonly<KonataRenderSpec> | undefined,
    candidateSpec: Readonly<KonataRenderSpec>,
): CycleNavigatorComparison | null {
    return baselineData === null || baselineSpec === undefined
        ? null
        : {
            baseline: { data: baselineData, spec: baselineSpec },
            candidate: { data: candidateData, spec: candidateSpec },
        };
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
    readonly traceNavigator: Readonly<TraceNavigatorSettings>;
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
    readonly onSetTraceNavigator: (settings: Readonly<TraceNavigatorSettings>) => void;
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
    traceNavigator,
    zoomStep,
    findResult,
    comparison,
    splitterPosition,
    onMoveSplitter,
    onSetTraceNavigator,
    onSetView,
    onCloseFindResult,
    onOpenTrace,
}, ref) {
    const viewerRef = useRef<HTMLDivElement>(null);
    const labelCanvasRef = useRef<HTMLCanvasElement>(null);
    const pipelineCanvasRef = useRef<HTMLCanvasElement>(null);
    const cycleNavigatorLabelCanvasRef = useRef<HTMLCanvasElement>(null);
    const cycleNavigatorCanvasRef = useRef<HTMLCanvasElement>(null);
    const instructionNavigatorCanvasRef = useRef<HTMLCanvasElement>(null);
    const cycleNavigatorDetailsVisibleRef = useRef(false);
    const cycleNavigatorPointerRef = useRef<{
        readonly pointerID: number;
        readonly grabOffset: number;
        readonly comparisonTrack: CycleNavigatorComparisonTrack | null;
    } | null>(null);
    const instructionNavigatorPointerRef = useRef<{
        readonly pointerID: number;
        readonly baselineSelected: boolean;
    } | null>(null);
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
    const traceNavigatorResizeRef = useRef({
        pointerID: null as number | null,
        axis: "cycle" as NavigatorAxis,
        startPosition: 0,
        startSize: 0,
        settings: traceNavigator,
        dragged: false,
    });
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
    const [resizingNavigator, setResizingNavigator] = useState<NavigatorAxis | null>(null);
    const [toolTip, setToolTip] = useState<CanvasToolTip | null>(null);
    const toolTipRef = useRef<HTMLPreElement>(null);
    // UI／制御層は集計結果の寿命だけを所有する。CycleNavigatorDataはTraceから
    // 再構築できる派生dataなのでStoreへ入れず、表示中のTraceSheet内に留める。
    const [navigatorData, setNavigatorData] = useState<CycleNavigatorData | null>(null);
    const [baselineNavigatorData, setBaselineNavigatorData] =
        useState<CycleNavigatorData | null>(null);
    const navigatorLiveDataRef = useRef<{
        readonly trace: ParsedTrace;
        data: CycleNavigatorData;
    } | null>(null);
    const loadStateRef = useRef(loadState);
    loadStateRef.current = loadState;
    const [navigatorError, setNavigatorError] = useState(false);
    const comparisonActive = comparison !== null;
    const comparisonMode = comparison?.mode ?? null;
    const comparisonOpacity = comparison?.opacity ?? 1;
    const traceNavigatorAvailable = trace !== null &&
        (!comparisonActive || baselineTrace !== null);
    const traceNavigatorVisible = traceNavigatorAvailable && traceNavigator.display !== "hidden";
    // コンパクト表示は常に全体を示すが、詳細表示の範囲設定は上書きしない。
    const cycleNavigatorRangeMode = traceNavigator.display === "compact" ? "overview" : traceNavigator.rangeMode;
    const modeSources = comparisonMode === "baseline"
        ? [baselineNavigatorData]
        : comparisonMode === "overlay"
            ? [baselineNavigatorData, navigatorData]
            : [navigatorData];
    const cycleNavigatorMode = resolveCycleNavigatorMode(
        traceNavigator.mode,
        ...modeSources,
    );
    const cycleNavigatorAnalysisUnavailable = resolveCycleNavigatorMode(
        "top-down",
        ...modeSources,
    ) !== "top-down";
    const traceNavigatorDataReady = navigatorData !== null &&
        (comparisonMode === null || baselineNavigatorData !== null);
    const navigatorSampleReady = trace !== null && (loadState === "ready" ||
        trace.opCount >= CYCLE_NAVIGATOR_INITIAL_SNAPSHOT_OP_COUNT);
    const navigatorStatusMessage = navigatorError
        ? "Trace navigator analysis unavailable"
        : !navigatorSampleReady
            ? `Collecting pipeline sample… ${(trace?.opCount ?? 0).toLocaleString()} / ${CYCLE_NAVIGATOR_INITIAL_SNAPSHOT_OP_COUNT.toLocaleString()} ops`
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
        let nextCandidate: Readonly<KonataRenderSpec> = candidateTarget;
        let nextBaseline: Readonly<KonataRenderSpec> | undefined = baselineTarget;
        if (comparisonMode === "overlay" && baselineTarget !== undefined) {
            // Overlayでは前面のBが算出した補正量をAにも適用し、A/B間の位置差を固定する。
            [nextCandidate, nextBaseline] = moveSynchronizedRenderSpecs(
                new KonataRenderMetrics(trace, candidateTarget),
                new KonataRenderMetrics(baselineTrace, baselineTarget),
                difference,
                adjustHorizontal,
                horizontalAnchorPixel,
            );
        }
        else {
            const applyCandidate = comparisonMode !== "baseline";
            const applyBaseline = baselineTarget !== undefined && comparisonMode !== "candidate";
            nextCandidate = applyCandidate
                ? new KonataRenderMetrics(trace, candidateTarget).withLogicalDifference(
                    difference,
                    adjustHorizontal,
                    horizontalAnchorPixel,
                )
                : candidateTarget;
            nextBaseline = baselineTarget === undefined
                ? undefined
                : applyBaseline
                    ? new KonataRenderMetrics(baselineTrace, baselineTarget).withLogicalDifference(
                        difference,
                        adjustHorizontal,
                        horizontalAnchorPixel,
                    )
                    : baselineTarget;
        }
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
            instructionNavigatorCanvasRef.current,
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
        const instructionNavigatorCanvas = instructionNavigatorCanvasRef.current;
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
        if (traceNavigatorAvailable && trace !== null && instructionNavigatorCanvas !== null) {
            const pipelineHeight = pipelineCanvas?.clientHeight ?? instructionNavigatorCanvas.clientHeight;
            if (comparisonMode !== null && baselineTrace !== null &&
                currentBaselineSpec !== undefined) {
                drawComparisonInstructionNavigator(
                    {
                        baseline: { trace: baselineTrace, spec: currentBaselineSpec },
                        candidate: { trace, spec: candidateSpec },
                    },
                    instructionNavigatorCanvas,
                    comparisonMode,
                    pipelineHeight,
                );
            }
            else {
                drawInstructionNavigator(
                    trace, candidateSpec, instructionNavigatorCanvas, pipelineHeight,
                );
            }
        }
        const navigatorLabelCanvas = cycleNavigatorLabelCanvasRef.current;
        const navigatorCanvas = cycleNavigatorCanvasRef.current;
        if (traceNavigatorAvailable && traceNavigatorDataReady && navigatorData !== null &&
            navigatorLabelCanvas !== null && navigatorCanvas !== null) {
            const navigatorComparison = createCycleNavigatorComparison(
                baselineNavigatorData, navigatorData, currentBaselineSpec, candidateSpec,
            );
            if (comparisonMode !== null && navigatorComparison !== null) {
                drawComparisonCycleNavigator(
                    navigatorComparison, navigatorLabelCanvas, navigatorCanvas,
                    comparisonMode, cycleNavigatorMode,
                    cycleNavigatorDetailsVisibleRef.current, cycleNavigatorRangeMode,
                );
            } else {
                drawCycleNavigator(
                    navigatorData, candidateSpec, navigatorLabelCanvas, navigatorCanvas,
                    cycleNavigatorMode, cycleNavigatorDetailsVisibleRef.current, cycleNavigatorRangeMode,
                );
            }
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
        baselineNavigatorData,
        baselineTrace,
        comparisonMode,
        comparisonOpacity,
        cycleNavigatorMode,
        cycleNavigatorRangeMode,
        displayRenderer,
        findResult,
        loadState,
        navigatorData,
        renderer,
        tiledRenderer,
        baselineTiledRenderer,
        tiledRenderingEnabled,
        trace,
        traceNavigatorAvailable,
        traceNavigatorDataReady,
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

    const showCycleNavigatorDetails = (visible: boolean) => {
        if (cycleNavigatorDetailsVisibleRef.current !== visible) {
            cycleNavigatorDetailsVisibleRef.current = visible;
            redraw();
        }
    };

    // Traceまたはpaneを切り替えた時は、以前のTraceから作った派生dataを外す。
    useEffect(() => {
        navigatorLiveDataRef.current = null;
        setNavigatorData(null);
        setNavigatorError(false);
    }, [trace, traceNavigatorAvailable]);

    // 最初の50k命令で構造を固定し、以降はEOFまで同じdataを増分更新する。
    // zoomやthemeの変更は下のuseLayoutEffectから同じ集計dataを再描画する。
    useEffect(() => {
        let canceled = false;
        if (!traceNavigatorAvailable || trace === null || !navigatorSampleReady) {
            return () => {
                canceled = true;
            };
        }
        setNavigatorError(false);

        void buildCycleNavigatorData(trace, {
            isCanceled: () => canceled,
            live: loadStateRef.current !== "ready",
        })
            .then((data) => {
                if (!canceled && data !== null) {
                    // 初期解析中に公開された分は下の増分更新で時間を区切って追記する。
                    navigatorLiveDataRef.current = { trace, data };
                    setNavigatorData(data);
                }
            })
            .catch((error: unknown) => {
                if (!canceled) {
                    console.warn("Could not build trace navigator analysis.", error);
                    setNavigatorError(true);
                }
            });
        return () => {
            canceled = true;
        };
    }, [navigatorSampleReady, trace, traceNavigatorAvailable]);

    // 比較元Aは比較Tabを作る時点で読み込み済みなので、live追記を持たず一度だけ集計する。
    useEffect(() => {
        let canceled = false;
        setBaselineNavigatorData(null);
        if (!traceNavigatorAvailable || !comparisonActive || baselineTrace === null) {
            return () => {
                canceled = true;
            };
        }
        void buildCycleNavigatorData(baselineTrace, { isCanceled: () => canceled })
            .then((data) => {
                if (!canceled && data !== null) {
                    setBaselineNavigatorData(data);
                }
            })
            .catch((error: unknown) => {
                if (!canceled) {
                    console.warn("Could not build baseline trace navigator analysis.", error);
                    setNavigatorError(true);
                }
            });
        return () => {
            canceled = true;
        };
    }, [baselineTrace, comparisonActive, traceNavigatorAvailable]);

    // Pipelineと同じ途中Traceの公開通知ごとに、節目間の差分だけをNavigatorへ反映する。
    useEffect(() => {
        const live = navigatorLiveDataRef.current;
        if (!traceNavigatorAvailable || trace === null || live?.trace !== trace) {
            return;
        }
        // 途中結果の公開はPipelineの更新へ合わせる。各sliceで再描画するとGPU側が詰まる。
        setNavigatorData(live.data);
        const update = () => {
            const previous = live.data;
            const data = updateCycleNavigatorData(previous, trace, loadState === "ready");
            live.data = data;
            if (data.sourceLastID > previous.sourceLastID && data.sourceLastID < trace.lastID) {
                timer = setTimeout(update, 0);
            } else {
                setNavigatorData(data);
            }
        };
        // 読込み完了後も残りを消化するが、未公開IDで進まなければ次の公開通知を待つ。
        let timer = setTimeout(update, 0);
        return () => clearTimeout(timer);
    }, [loadState, renderVersion, trace, traceNavigatorAvailable, navigatorData === null]);

    useLayoutEffect(() => {
        // 読込み中はPipelineの再描画に同乗する。EOF後に残った解析が終わった場合も反映する。
        if (loadState === "ready") redraw();
    }, [redraw, loadState, navigatorData, baselineNavigatorData]);

    useLayoutEffect(() => {
        const element = toolTipRef.current;
        if (element === null || toolTip?.bottomBoundary === undefined) {
            return;
        }
        // Pipeline下端を越える場合だけpointer上へ返し、Navigatorを覆わない。
        element.style.top = `${toolTip.top}px`;
        if (toolTip.top + element.offsetHeight > toolTip.bottomBoundary) {
            element.style.top = `${Math.max(
                0,
                toolTip.top - element.offsetHeight -
                    TOOLTIP_BELOW_POINTER_OFFSET - TOOLTIP_ABOVE_POINTER_GAP,
            )}px`;
        }
    }, [toolTip]);

    useLayoutEffect(() => {
        // 初期解析の完了・設定・paneの大きさ変更も共通の描画frameへまとめる。
        redraw();
    }, [redraw, traceNavigator, traceNavigatorAvailable, traceNavigatorDataReady]);

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

    const setNavigatorSize = (axis: NavigatorAxis, size: number, original = traceNavigator) => {
        const viewer = viewerRef.current;
        if (viewer === null) {
            return;
        }
        const cycle = axis === "cycle";
        const minimum = cycle ? MIN_TRACE_NAVIGATOR_HEIGHT : MIN_INSTRUCTION_NAVIGATOR_WIDTH;
        const maximum = cycle ? viewer.clientHeight - MIN_PIPELINE_HEIGHT : viewer.clientWidth / 4;
        const expanded = size >= minimum;
        const expandedSize = Math.round(Math.max(minimum, Math.min(size, maximum)));
        onSetTraceNavigator({
            ...traceNavigator,
            // dragで畳んでも、clickでgesture開始前の詳細サイズへ戻せるようにする。
            ...(cycle
                ? { display: expanded ? "expanded" : size >= COMPACT_TRACE_NAVIGATOR_HEIGHT ? "compact" : "hidden",
                    height: expanded ? expandedSize : original.height }
                : { instructionVisible: expanded,
                    instructionWidth: expanded ? expandedSize : original.instructionWidth }),
        });
    };

    const handleNavigatorResizerPointerDown = (event: PointerEvent<HTMLDivElement>, axis: NavigatorAxis) => {
        if (event.button !== 0 || traceNavigatorResizeRef.current.pointerID !== null) {
            return;
        }
        const canvas = axis === "cycle" ? cycleNavigatorCanvasRef.current : instructionNavigatorCanvasRef.current;
        const rect = canvas?.parentElement?.getBoundingClientRect();
        traceNavigatorResizeRef.current = {
            pointerID: event.pointerId,
            axis,
            startPosition: axis === "cycle" ? event.clientY : event.clientX,
            startSize: (axis === "cycle" ? rect?.height : rect?.width) ?? 0,
            settings: traceNavigator,
            dragged: false,
        };
        event.currentTarget.setPointerCapture(event.pointerId);
        setToolTip(null);
        event.preventDefault();
        event.stopPropagation();
    };

    const handleNavigatorResizerPointerMove = (event: PointerEvent<HTMLDivElement>) => {
        const resize = traceNavigatorResizeRef.current;
        if (resize.pointerID !== event.pointerId) {
            return;
        }
        // つかんだ位置のずれを保ち、clickの小さな揺れではサイズを変更しない。
        const delta = resize.startPosition - (resize.axis === "cycle" ? event.clientY : event.clientX);
        if (resize.dragged || Math.abs(delta) >= 4) {
            resize.dragged = true;
            setResizingNavigator(resize.axis);
            setNavigatorSize(resize.axis, resize.startSize + delta, resize.settings);
        }
        event.preventDefault();
        event.stopPropagation();
    };

    const handleNavigatorResizerPointerUp = (event: PointerEvent<HTMLDivElement>) => {
        const resize = traceNavigatorResizeRef.current;
        if (resize.pointerID !== event.pointerId) {
            return;
        }
        if (event.type === "pointerup") {
            handleNavigatorResizerPointerMove(event);
        } else {
            onSetTraceNavigator(resize.settings);
            resize.dragged = true;
        }
        resize.pointerID = null;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
        }
        setResizingNavigator(null);
        event.preventDefault();
        event.stopPropagation();
    };

    const handleWheel = useCallback((event: WheelEvent) => {
        const zoomRequested = event.ctrlKey || event.metaKey;
        const target = event.target instanceof Element ? event.target : null;
        const viewer = viewerRef.current;
        const insideViewer = target !== null && viewer?.contains(target) === true;
        // 通常wheelはPipelineだけで扱う。Ctrl／Command+wheelはtoolbarやNavigatorでも
        // browser zoomへ渡さず、表示中Traceのzoomとして扱う。
        if (!zoomRequested && (!insideViewer ||
            target?.closest(".trace-navigator-pane, .navigator-resizer"))) {
            return;
        }
        event.preventDefault();
        if (trace === null) {
            return;
        }
        if (zoomRequested) {
            const rect = pipelineCanvasRef.current?.getBoundingClientRect();
            const x = rect === undefined
                ? 0
                : Math.max(0, Math.min(rect.width, event.clientX - rect.left));
            const localY = rect === undefined ? 0 : event.clientY - rect.top;
            const y = rect === undefined
                ? 0
                : localY < 0 || localY > rect.height ? rect.height / 2 : localY;
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
        // Reactのpassiveなwheel委譲ではCtrl+wheelのbrowser zoomを止められない。
        // toolbarを含む文書全体で捕捉し、handleWheel側で通常wheelをviewer内へ限定する。
        document.addEventListener("wheel", handleWheel, { passive: false });
        document.addEventListener("keydown", handleModifierKey);
        document.addEventListener("keyup", handleModifierKey);
        window.addEventListener("blur", clearModifierKey);
        return () => {
            document.removeEventListener("wheel", handleWheel);
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

    const moveCycleNavigatorViewport = (
        canvas: HTMLCanvasElement,
        clientX: number,
        grabOffset: number,
        comparisonTrack: CycleNavigatorComparisonTrack | null,
    ) => {
        if (navigatorData === null) {
            return;
        }
        const rect = canvas.getBoundingClientRect();
        const width = canvas.clientWidth;
        const x = rect.width === 0 ? 0 : (clientX - rect.left) * width / rect.width;
        const candidateSpec = viewController.currentSpec;
        const baselineSpec = viewController.currentBaselineSpec;
        const navigatorComparison = createCycleNavigatorComparison(
            baselineNavigatorData, navigatorData, baselineSpec, candidateSpec,
        );
        const position = comparisonMode === null
            ? getCycleNavigatorScrollPosition(
                navigatorData, candidateSpec, width, x - grabOffset,
            )
            : navigatorComparison === null
                ? null
                : getComparisonCycleNavigatorScrollPosition(
                    navigatorComparison,
                    comparisonMode,
                    comparisonTrack ?? "candidate",
                    width,
                    x - grabOffset,
                );
        if (position === null) {
            return;
        }
        const candidateCycle = typeof position === "number"
            ? position
            : position.candidate;
        const baselineCycle = typeof position === "number"
            ? baselineSpec?.position[0]
            : position.baseline;
        const candidateY = comparisonTrack === "baseline"
            ? candidateSpec.position[1]
            : new KonataRenderMetrics(trace, candidateSpec)
                .getPositionYFromCycle(candidateCycle) ?? candidateSpec.position[1];
        const baselineY = baselineSpec === undefined || baselineCycle === undefined ||
            comparisonTrack !== "baseline"
            ? baselineSpec?.position[1]
            : new KonataRenderMetrics(baselineTrace, baselineSpec)
                .getPositionYFromCycle(baselineCycle) ?? baselineSpec.position[1];
        setToolTip(null);
        viewController.setImmediately(
            {
                position: [candidateCycle, candidateY],
                zoomLevel: candidateSpec.zoomLevel,
            },
            baselineSpec === undefined || baselineCycle === undefined
                ? undefined
                : {
                    position: [baselineCycle, baselineY ?? baselineSpec.position[1]],
                    zoomLevel: baselineSpec.zoomLevel,
                },
        );
    };

    const handleCycleNavigatorPointerDown = (event: PointerEvent<HTMLCanvasElement>) => {
        if (event.button !== 0 || cycleNavigatorRangeMode !== "overview" ||
            navigatorData === null || cycleNavigatorPointerRef.current !== null) {
            return;
        }
        const canvas = event.currentTarget;
        const rect = canvas.getBoundingClientRect();
        const width = canvas.clientWidth;
        const x = rect.width === 0 ? 0 : (event.clientX - rect.left) * width / rect.width;
        const y = rect.height === 0
            ? 0
            : (event.clientY - rect.top) * canvas.clientHeight / rect.height;
        const candidateSpec = viewController.currentSpec;
        const baselineSpec = viewController.currentBaselineSpec;
        const navigatorComparison = createCycleNavigatorComparison(
            baselineNavigatorData, navigatorData, baselineSpec, candidateSpec,
        );
        const comparisonTrack: CycleNavigatorComparisonTrack | null = comparisonMode === null
            ? null
            : comparisonMode === "overlay"
                ? y < canvas.clientHeight / 2 ? "baseline" : "candidate"
                : comparisonMode;
        const viewport = comparisonMode === null
            ? getCycleNavigatorViewport(navigatorData, candidateSpec, width)
            : navigatorComparison === null
                ? null
                : getComparisonCycleNavigatorViewport(
                    navigatorComparison,
                    comparisonMode,
                    comparisonTrack ?? "candidate",
                    width,
                );
        if (viewport === null) {
            return;
        }
        const insideViewport = x >= viewport.left && x <= viewport.left + viewport.width;
        const grabOffset = insideViewport ? x - viewport.left : viewport.width / 2;
        cycleNavigatorPointerRef.current = {
            pointerID: event.pointerId,
            grabOffset,
            comparisonTrack,
        };
        canvas.setPointerCapture(event.pointerId);
        if (!insideViewport) {
            moveCycleNavigatorViewport(
                canvas, event.clientX, grabOffset, comparisonTrack,
            );
        }
        event.preventDefault();
        event.stopPropagation();
    };

    const handleCycleNavigatorPointerMove = (event: PointerEvent<HTMLCanvasElement>) => {
        const pointer = cycleNavigatorPointerRef.current;
        if (pointer?.pointerID !== event.pointerId) {
            return;
        }
        moveCycleNavigatorViewport(
            event.currentTarget,
            event.clientX,
            pointer.grabOffset,
            pointer.comparisonTrack,
        );
        event.preventDefault();
        event.stopPropagation();
    };

    const handleCycleNavigatorPointerUp = (event: PointerEvent<HTMLCanvasElement>) => {
        if (cycleNavigatorPointerRef.current?.pointerID !== event.pointerId) {
            return;
        }
        cycleNavigatorPointerRef.current = null;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
        }
        event.preventDefault();
        event.stopPropagation();
    };

    const moveInstructionNavigatorPosition = (
        canvas: HTMLCanvasElement,
        clientY: number,
        baselineSelected: boolean,
    ) => {
        if (trace === null) {
            return;
        }
        const rect = canvas.getBoundingClientRect();
        const height = canvas.clientHeight;
        const y = rect.height === 0 ? 0 : (clientY - rect.top) * height / rect.height;
        const candidateSpec = viewController.currentSpec;
        const baselineSpec = viewController.currentBaselineSpec;
        const selectedTrace = baselineSelected ? baselineTrace : trace;
        const selectedSpec = baselineSelected ? baselineSpec : candidateSpec;
        if (selectedTrace === null || selectedSpec === undefined) {
            return;
        }
        const position = getInstructionNavigatorPosition(
            selectedTrace, selectedSpec, height, y,
        );
        if (position === null) {
            return;
        }
        const movedView = {
            position,
            zoomLevel: selectedSpec.zoomLevel,
        };
        setToolTip(null);
        viewController.setImmediately(
            baselineSelected ? getKonataView(candidateSpec) : movedView,
            baselineSpec === undefined
                ? undefined
                : baselineSelected ? movedView : getKonataView(baselineSpec),
        );
    };

    const handleInstructionNavigatorPointerDown = (event: PointerEvent<HTMLCanvasElement>) => {
        if (event.button !== 0 || trace === null ||
            instructionNavigatorPointerRef.current !== null) {
            return;
        }
        const canvas = event.currentTarget;
        const rect = canvas.getBoundingClientRect();
        const width = canvas.clientWidth;
        const x = rect.width === 0 ? 0 : (event.clientX - rect.left) * width / rect.width;
        const baselineSelected = comparisonMode === "baseline" ||
            (comparisonMode === "overlay" && x < Math.floor(width / 2));
        instructionNavigatorPointerRef.current = {
            pointerID: event.pointerId,
            baselineSelected,
        };
        canvas.setPointerCapture(event.pointerId);
        moveInstructionNavigatorPosition(
            canvas, event.clientY, baselineSelected,
        );
        event.preventDefault();
        event.stopPropagation();
    };

    const handleInstructionNavigatorPointerMove = (event: PointerEvent<HTMLCanvasElement>) => {
        const pointer = instructionNavigatorPointerRef.current;
        if (pointer?.pointerID !== event.pointerId) {
            return;
        }
        moveInstructionNavigatorPosition(
            event.currentTarget,
            event.clientY,
            pointer.baselineSelected,
        );
        event.preventDefault();
        event.stopPropagation();
    };

    const handleInstructionNavigatorPointerUp = (event: PointerEvent<HTMLCanvasElement>) => {
        if (instructionNavigatorPointerRef.current?.pointerID !== event.pointerId) {
            return;
        }
        instructionNavigatorPointerRef.current = null;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
        }
        event.preventDefault();
        event.stopPropagation();
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
        if (text === null) {
            setToolTip(null);
            return;
        }
        const pointerTop = event.clientY - viewerRect.top;
        setToolTip({
            left: event.clientX - viewerRect.left,
            top: pointerTop + TOOLTIP_BELOW_POINTER_OFFSET,
            text,
            bottomBoundary: pane === "pipeline"
                ? canvasRect.bottom - viewerRect.top
                : undefined,
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
            className={`viewer${trace === null ? " is-empty" : ""}${traceNavigatorAvailable ? " has-trace-navigator" : ""}${traceNavigatorVisible ? ` is-trace-navigator-${traceNavigator.display}` : ""}${traceNavigatorAvailable && traceNavigator.instructionVisible ? " is-instruction-navigator-visible" : ""}${isPanning ? " is-panning" : ""}${isResizing ? " is-resizing" : ""}${resizingNavigator === "cycle" ? " is-resizing-trace-navigator" : ""}${resizingNavigator === "instruction" ? " is-resizing-instruction-navigator" : ""}`}
            // 保存したdesktop幅を維持したまま、狭い画面ではCSS側だけで表示幅を制限する。
            style={{
                "--label-pane-width": `${splitterPosition}px`,
                "--trace-navigator-height": `${traceNavigator.height}px`,
                "--trace-navigator-compact-height": `${COMPACT_TRACE_NAVIGATOR_HEIGHT}px`,
                "--instruction-navigator-saved-width": `${traceNavigator.instructionWidth}px`,
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
            {traceNavigatorAvailable && traceNavigator.instructionVisible && (
                <section
                    id="instruction-trace-navigator"
                    className="viewer-pane trace-navigator-pane instruction-navigator-pane"
                    aria-label="Instruction navigator"
                    onPointerDown={(event) => event.stopPropagation()}
                >
                    <canvas
                        ref={instructionNavigatorCanvasRef}
                        aria-label="Instruction navigator canvas"
                        onPointerDown={handleInstructionNavigatorPointerDown}
                        onPointerMove={handleInstructionNavigatorPointerMove}
                        onPointerUp={handleInstructionNavigatorPointerUp}
                        onPointerCancel={handleInstructionNavigatorPointerUp}
                        onLostPointerCapture={handleInstructionNavigatorPointerUp}
                    />
                </section>
            )}
            {traceNavigatorAvailable && (
                <>
                    {(["cycle", "instruction"] as const).map((axis) => {
                        const cycle = axis === "cycle";
                        const display = cycle ? traceNavigator.display
                            : traceNavigator.instructionVisible ? "expanded" : "hidden";
                        const visible = display !== "hidden";
                        const size = cycle
                            ? display === "compact" ? COMPACT_TRACE_NAVIGATOR_HEIGHT : traceNavigator.height
                            : traceNavigator.instructionWidth;
                        const minimum = cycle ? MIN_TRACE_NAVIGATOR_HEIGHT : MIN_INSTRUCTION_NAVIGATOR_WIDTH;
                        const name = cycle ? "trace navigator" : "instruction navigator";
                        const prefix = cycle ? "trace-navigator" : "instruction-navigator";
                        return (
                            <div
                                key={axis}
                                className={`navigator-resizer ${prefix}-resizer${resizingNavigator === axis ? " is-resizing" : ""}`}
                                role="separator"
                                aria-label={`Resize ${name}`}
                                aria-orientation={cycle ? "horizontal" : "vertical"}
                                aria-valuemin={0}
                                aria-valuenow={visible ? size : 0}
                                aria-valuetext={display}
                                onClick={(event) => {
                                    event.stopPropagation();
                                    // drag直後のclickでは開閉しない。keyboardのclickは許可する。
                                    if (event.detail === 0 || !traceNavigatorResizeRef.current.dragged) {
                                        setToolTip(null);
                                        onSetTraceNavigator({ ...traceNavigator,
                                            ...(cycle ? { display: display === "expanded" ? "compact"
                                                : display === "compact" ? "hidden" : "expanded" }
                                                : { instructionVisible: !visible }) });
                                    }
                                }}
                                onKeyDown={(event) => {
                                    // buttonの開閉keyを、Pipeline側のshortcutへ渡さない。
                                    if (event.key === "Enter" || event.key === " ") {
                                        event.stopPropagation();
                                        return;
                                    }
                                    const grow = cycle ? "ArrowUp" : "ArrowLeft";
                                    const shrink = cycle ? "ArrowDown" : "ArrowRight";
                                    if (event.key !== grow && event.key !== shrink) return;
                                    event.preventDefault();
                                    event.stopPropagation();
                                    setNavigatorSize(axis, event.key === grow
                                        ? (display === "hidden" ? (cycle ? COMPACT_TRACE_NAVIGATOR_HEIGHT : minimum)
                                            : display === "compact" ? traceNavigator.height : size + 16)
                                        : (display === "expanded"
                                            ? (size > minimum ? size - 16 : cycle ? COMPACT_TRACE_NAVIGATOR_HEIGHT : 0)
                                            : 0));
                                }}
                                onPointerDown={(event) => handleNavigatorResizerPointerDown(event, axis)}
                                onPointerMove={handleNavigatorResizerPointerMove}
                                onPointerUp={handleNavigatorResizerPointerUp}
                                onPointerCancel={handleNavigatorResizerPointerUp}
                                onLostPointerCapture={handleNavigatorResizerPointerUp}
                            >
                                <button
                                    type="button"
                                    className={`navigator-grip ${prefix}-toggle`}
                                    aria-label={`${cycle && display === "expanded" ? "Compact" : visible ? "Hide" : "Show"} ${name}`}
                                    aria-controls={`${axis}-trace-navigator`}
                                    aria-expanded={visible}
                                    data-display={display}
                                />
                            </div>
                        );
                    })}
                </>
            )}
            {traceNavigatorVisible && (
                <>
                    <section
                        className="viewer-pane trace-navigator-pane trace-navigator-cycle-label-pane"
                        aria-label="Cycle navigator labels"
                        onPointerDown={(event) => event.stopPropagation()}
                        onMouseEnter={() => showCycleNavigatorDetails(true)}
                        onMouseLeave={() => showCycleNavigatorDetails(false)}
                    >
                        <canvas ref={cycleNavigatorLabelCanvasRef} aria-label="Cycle navigator labels canvas" />
                        <select
                            className="trace-navigator-mode"
                            aria-label="Cycle navigator mode"
                            value={cycleNavigatorMode}
                            onChange={(event) => onSetTraceNavigator({
                                ...traceNavigator,
                                mode: event.currentTarget.value as CycleNavigatorMode,
                            })}
                        >
                            <option
                                value="top-down"
                                disabled={cycleNavigatorAnalysisUnavailable}
                            >Top-down</option>
                            <option value="fetch">Fetch</option>
                            <option
                                value="issue"
                                disabled={cycleNavigatorAnalysisUnavailable}
                            >Issue</option>
                            <option value="commit">Commit</option>
                            <option
                                value="flush"
                                disabled={cycleNavigatorAnalysisUnavailable}
                            >Flush</option>
                            <option
                                value="latency"
                                disabled={cycleNavigatorAnalysisUnavailable}
                            >Latency</option>
                        </select>
                        <div
                            className="trace-navigator-range"
                            role="group"
                            aria-label="Navigator view"
                        >
                            {(["follow", "overview"] as const).map((rangeMode) => (
                                <button
                                    key={rangeMode}
                                    type="button"
                                    aria-pressed={traceNavigator.rangeMode === rangeMode}
                                    onClick={() => onSetTraceNavigator({
                                        ...traceNavigator,
                                        rangeMode,
                                    })}
                                >
                                    {rangeMode === "follow" ? "Detail" : "Overview"}
                                </button>
                            ))}
                        </div>
                    </section>
                    <div className="trace-navigator-cycle-divider" aria-hidden="true" />
                    <section
                        id="cycle-trace-navigator"
                        className={`viewer-pane trace-navigator-pane trace-navigator-cycle-pane${cycleNavigatorRangeMode === "overview" ? " is-overview" : ""}`}
                        aria-label="Cycle navigator"
                        onPointerDown={(event) => event.stopPropagation()}
                        onMouseEnter={() => setToolTip(null)}
                    >
                        <canvas
                            ref={cycleNavigatorCanvasRef}
                            aria-label="Cycle navigator canvas"
                            onPointerDown={handleCycleNavigatorPointerDown}
                            onPointerMove={handleCycleNavigatorPointerMove}
                            onPointerUp={handleCycleNavigatorPointerUp}
                            onPointerCancel={handleCycleNavigatorPointerUp}
                            onLostPointerCapture={handleCycleNavigatorPointerUp}
                        />
                        {!traceNavigatorDataReady && (
                            <span className="trace-navigator-cycle-status">
                                {navigatorStatusMessage}
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
                    ref={toolTipRef}
                    className="canvas-tooltip"
                    role="tooltip"
                    style={{
                        left: toolTip.left,
                        top: toolTip.top,
                        maxHeight: toolTip.bottomBoundary === undefined
                            ? undefined
                            : `min(18rem, ${toolTip.bottomBoundary}px)`,
                    }}
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
