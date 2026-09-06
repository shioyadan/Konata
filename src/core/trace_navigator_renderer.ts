/** Trace navigatorのcycle／instruction方向を集計済みdataまたはOpから描画する。 */
import darkStyle from "../../theme/dark/style.json";
import lightStyle from "../../theme/light/style.json";
import {
    getCycleNavigatorActivity,
    getCycleNavigatorActivityMaximum,
    getCycleNavigatorTopDown,
    resolveCycleNavigatorMode,
    type CycleNavigatorData,
    type CycleNavigatorMode,
    type CycleNavigatorTopDownSample,
} from "./trace_navigator_analysis";
import {
    getKonataZoomScale,
    KONATA_OP_WIDTH,
    KonataRenderMetrics,
    type KonataRenderSpec,
} from "./konata_renderer";
import type { ParsedTrace } from "./model";

// 縮小表示ではOp描画と同じくglobal cycleへ揃えた代表点だけを見る。各cycle内では
// 全allocation slotを数えるため、slot位置によるcategory比率の偏りは作らない。
const MIN_VIEWPORT_SIZE = 8;
const INSTRUCTION_LATENCY_MAGNIFICATION = 8;
const styles = { light: lightStyle, dark: darkStyle };

export type CycleNavigatorRangeMode = "follow" | "overview";
export type CycleNavigatorComparisonMode = "baseline" | "overlay" | "candidate";
export type CycleNavigatorComparisonTrack = "baseline" | "candidate";

export interface CycleNavigatorViewport {
    readonly left: number;
    readonly width: number;
}

export interface CycleNavigatorSource {
    readonly data: Readonly<CycleNavigatorData>;
    readonly spec: Readonly<KonataRenderSpec>;
}

export interface CycleNavigatorComparison {
    readonly baseline: Readonly<CycleNavigatorSource>;
    readonly candidate: Readonly<CycleNavigatorSource>;
}

export interface InstructionNavigatorSource {
    readonly trace: ParsedTrace;
    readonly spec: Readonly<KonataRenderSpec>;
}

export interface InstructionNavigatorComparison {
    readonly baseline: Readonly<InstructionNavigatorSource>;
    readonly candidate: Readonly<InstructionNavigatorSource>;
}

interface CycleScale {
    readonly leftCycle: number;
    readonly pixelsPerCycle: number;
}

interface PreparedCanvas {
    readonly context: CanvasRenderingContext2D;
    readonly width: number;
    readonly height: number;
}

interface BreakdownColors {
    readonly retiring: string;
    readonly badSpeculation: string;
    readonly unresolved: string;
    readonly frontendBound: string;
    readonly backendBound: string;
    readonly flush: string;
    readonly latency: string;
}

interface StageColorTone {
    readonly sBegin: string;
    readonly sEnd: string;
    readonly lBegin: string;
    readonly lEnd: string;
}

const activityInfo = {
    fetch: { unit: " ops/cycle", color: "frontendBound" },
    issue: { unit: " ops/cycle", color: "backendBound" },
    commit: { unit: " ops/cycle", color: "retiring" },
    flush: { unit: " ops/cycle", color: "flush" },
    latency: { unit: " cycles", color: "latency" },
} as const;

function prepareCanvas(canvas: HTMLCanvasElement): PreparedCanvas {
    const width = Math.max(1, canvas.clientWidth);
    const height = Math.max(1, canvas.clientHeight);
    const pixelRatio = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;
    const backingWidth = Math.max(1, Math.round(width * pixelRatio));
    const backingHeight = Math.max(1, Math.round(height * pixelRatio));
    if (canvas.width !== backingWidth || canvas.height !== backingHeight) {
        canvas.width = backingWidth;
        canvas.height = backingHeight;
    }
    const context = canvas.getContext("2d");
    if (context === null) {
        throw new Error("A 2D canvas context is required to draw the trace navigator.");
    }
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    return { context, width, height };
}

function createBreakdownColors(
    stageColor: Readonly<StageColorTone>,
    backgroundColor: string,
): BreakdownColors {
    // gradient両端のうち50%から遠いtoneを中間へ寄せ、theme分岐なしで
    // 広い単色stackに適した明るい側のtoneを得る。
    const tone = (begin: string, end: string) => Math.round(50 + Math.max(
        Math.abs(Number(begin) - 50),
        Math.abs(Number(end) - 50),
    ) / 2);
    // 広い単色面はstageより鮮やかに見えるため、theme共通で彩度だけを抑える。
    const saturation = tone(stageColor.sBegin, stageColor.sEnd) - 20;
    const lightness = tone(stageColor.lBegin, stageColor.lEnd);
    const create = (hue: number, neutral = false) =>
        `hsl(${hue},${neutral ? 0 : saturation}%,${lightness}%)`;
    return {
        retiring: create(140),
        badSpeculation: create(0, true),
        frontendBound: create(240),
        backendBound: create(30),
        flush: create(0),
        latency: create(280),
        unresolved: backgroundColor,
    };
}

function drawBreakdown(
    context: CanvasRenderingContext2D,
    sample: Readonly<CycleNavigatorTopDownSample>,
    colors: Readonly<BreakdownColors>,
    left: number,
    width: number,
    top: number,
    height: number,
): void {
    if (sample.totalSlots <= 0) {
        return;
    }
    const segments = [
        [sample.squashedSlots + sample.recoveryBubbleSlots, colors.badSpeculation],
        [sample.frontendBound, colors.frontendBound],
        [sample.backendBound, colors.backendBound],
        [sample.unresolvedSlots, colors.unresolved],
        [sample.retiringSlots, colors.retiring],
    ] as const;
    let segmentTop = top;
    for (const [value, color] of segments) {
        const segmentHeight = height * value / sample.totalSlots;
        if (segmentHeight > 0) {
            context.fillStyle = color;
            context.fillRect(left, segmentTop, width, segmentHeight);
        }
        segmentTop += segmentHeight;
    }
}

function drawViewport(
    context: CanvasRenderingContext2D,
    viewport: Readonly<CycleNavigatorViewport> | null,
    width: number,
    top: number,
    height: number,
    shadeColor: string,
    borderColor: string,
): void {
    if (viewport === null) return;
    const right = Math.min(width, viewport.left + viewport.width);
    context.fillStyle = shadeColor;
    context.fillRect(0, top, viewport.left, height);
    context.fillRect(right, top, Math.max(0, width - right), height);
    context.strokeStyle = borderColor;
    context.lineWidth = 1;
    context.strokeRect(
        viewport.left + 0.5,
        top + 0.5,
        Math.max(0, right - viewport.left - 1),
        Math.max(0, height - 1),
    );
}

function drawLabels(
    data: Readonly<CycleNavigatorData>,
    spec: Readonly<KonataRenderSpec>,
    canvas: Readonly<PreparedCanvas>,
    colors: Readonly<BreakdownColors>,
    mode: CycleNavigatorMode,
    showDetails: boolean,
    activityMaximum?: number,
): void {
    const { topDown } = data;
    const style = styles[spec.theme];
    const margin = Number(style.labelPane.marginLeft);
    const { context } = canvas;
    context.font = `${style.fontStyle} 12px ${style.fontFamily}`;
    context.textAlign = "left";
    context.textBaseline = "middle";
    context.fillStyle = style.labelPane.fontColor;
    const format = (value: number) => Number.isInteger(value)
        ? value.toString()
        : value.toFixed(1);
    const detailLeft = 128;
    const detailCenter = 16;
    if (mode !== "top-down") {
        if (!showDetails) {
            return;
        }
        const info = activityInfo[mode];
        const prefix = mode === "issue" && topDown !== null
            ? `${topDown.executionStage.label} · `
            : mode === "latency" && topDown !== null
                ? `${topDown.executionStage.label} → completion · `
                : "";
        const maximumValue = activityMaximum ??
            getCycleNavigatorActivityMaximum(data, mode);
        const maximum = maximumValue >= 255 ? "≥255" : format(maximumValue);
        let detailWidth = canvas.width - detailLeft - margin;
        if (mode === "fetch" || mode === "issue") {
            const label = "Later flushed";
            context.font = `${style.fontStyle} 11px ${style.fontFamily}`;
            const flushedLeft = Math.max(
                detailLeft,
                canvas.width - margin - context.measureText(label).width - 15,
            );
            context.fillStyle = style.traceNavigator.flushedColor;
            context.fillRect(flushedLeft, detailCenter - 5, 10, 10);
            context.fillStyle = style.labelPane.fontColor;
            context.fillText(label, flushedLeft + 15, detailCenter);
            detailWidth = flushedLeft - detailLeft - 10;
        }
        context.font = `${style.fontStyle} 11px ${style.fontFamily}`;
        context.fillStyle = style.labelPane.fontColor;
        context.fillText(
            `${prefix}max ${maximum}${info.unit}`,
            detailLeft,
            detailCenter,
            Math.max(1, detailWidth),
        );
        return;
    }
    if (topDown === null) {
        return;
    }

    const legendWidth = 64;
    const legendLeft = Math.max(margin, canvas.width - margin - legendWidth);
    if (showDetails) {
        context.font = `${style.fontStyle} 11px ${style.fontFamily}`;
        context.fillText(
            `AUTO · ${topDown.allocationStage.label} ` +
                `≥${format(topDown.allocationWidth)}/c → ${topDown.executionStage.label}`,
            detailLeft,
            detailCenter,
            Math.max(1, legendLeft - detailLeft - 10),
        );
    }

    const legends = [
        ["Bad spec", colors.badSpeculation],
        ["Front", colors.frontendBound],
        ["Back", colors.backendBound],
        ["Retire", colors.retiring],
    ] as const;
    context.font = `${style.fontStyle} 11px ${style.fontFamily}`;
    legends.forEach(([label, color], index) => {
        const top = 7 + index * 14;
        context.fillStyle = color;
        context.fillRect(legendLeft, top, 10, 10);
        context.fillStyle = style.labelPane.fontColor;
        context.fillText(
            label,
            legendLeft + 15,
            top + 5,
            Math.max(1, canvas.width - margin - legendLeft - 15),
        );
    });
}

function getCycleScale(
    cycleCount: number,
    spec: Readonly<KonataRenderSpec>,
    width: number,
    rangeMode: CycleNavigatorRangeMode,
): CycleScale {
    if (rangeMode === "overview") {
        return {
            leftCycle: 0,
            pixelsPerCycle: width / Math.max(1, cycleCount),
        };
    }
    return {
        leftCycle: spec.position[0],
        pixelsPerCycle: KONATA_OP_WIDTH * getKonataZoomScale(spec.zoomLevel),
    };
}

function getViewport(
    start: number,
    end: number,
    position: number,
    visibleLength: number,
    trackLength: number,
): CycleNavigatorViewport | null {
    const range = end - start;
    if (trackLength <= 0 || range <= 0) {
        return null;
    }
    if (visibleLength >= range) {
        return { left: 0, width: trackLength };
    }
    const viewportLength = Math.min(
        trackLength,
        Math.max(MIN_VIEWPORT_SIZE, trackLength * visibleLength / range),
    );
    const maximumPosition = end - visibleLength;
    const clampedPosition = Math.min(Math.max(position, start), maximumPosition);
    return {
        left: (clampedPosition - start) / (maximumPosition - start) *
            (trackLength - viewportLength),
        width: viewportLength,
    };
}

function getScrollPosition(
    start: number,
    end: number,
    visibleLength: number,
    trackLength: number,
    viewportOffset: number,
    viewport: Readonly<CycleNavigatorViewport>,
): number {
    const movableLength = trackLength - viewport.width;
    if (movableLength <= 0) {
        return start;
    }
    const maximumPosition = end - visibleLength;
    return start + Math.min(Math.max(viewportOffset, 0), movableLength) / movableLength *
        (maximumPosition - start);
}

/** Overview上で、現在のPipeline表示範囲に対応するscrollbar thumbを返す。 */
export function getCycleNavigatorViewport(
    cycleCount: number,
    spec: Readonly<KonataRenderSpec>,
    width: number,
): CycleNavigatorViewport | null {
    const pixelsPerCycle = KONATA_OP_WIDTH * getKonataZoomScale(spec.zoomLevel);
    const visibleCycles = width / pixelsPerCycle;
    return getViewport(0, cycleCount, spec.position[0], visibleCycles, width);
}

/** Overviewのthumb左端を、Pipeline左端のcycleへ戻す。 */
export function getCycleNavigatorScrollPosition(
    cycleCount: number,
    spec: Readonly<KonataRenderSpec>,
    width: number,
    viewportLeft: number,
): number | null {
    const viewport = getCycleNavigatorViewport(cycleCount, spec, width);
    if (viewport === null) {
        return null;
    }
    const pixelsPerCycle = KONATA_OP_WIDTH * getKonataZoomScale(spec.zoomLevel);
    return getScrollPosition(
        0,
        cycleCount,
        width / pixelsPerCycle,
        width,
        viewportLeft,
        viewport,
    );
}

// 比較Overviewの軸長は描画・thumb・dragで共用し、片側を動かしても変えない。
function getComparisonCycleCount(
    comparison: Readonly<CycleNavigatorComparison>,
    mode: CycleNavigatorComparisonMode,
): number {
    return mode === "overlay"
        ? Math.max(comparison.baseline.data.cycleCount, comparison.candidate.data.cycleCount)
        : comparison[mode].data.cycleCount;
}

/** 比較Overview上で、指定したA/BそれぞれのPipeline表示範囲を返す。 */
export function getComparisonCycleNavigatorViewport(
    comparison: Readonly<CycleNavigatorComparison>,
    mode: CycleNavigatorComparisonMode,
    track: CycleNavigatorComparisonTrack,
    width: number,
): CycleNavigatorViewport | null {
    return getCycleNavigatorViewport(
        getComparisonCycleCount(comparison, mode),
        comparison[mode === "overlay" ? track : mode].spec,
        width,
    );
}

/** 比較Overviewのthumb左端を、指定したA/B片側のcycleへ戻す。 */
export function getComparisonCycleNavigatorScrollPosition(
    comparison: Readonly<CycleNavigatorComparison>,
    mode: CycleNavigatorComparisonMode,
    track: CycleNavigatorComparisonTrack,
    width: number,
    viewportLeft: number,
): number | null {
    // Rendererは選択側の座標だけを返す。両viewへの反映はUI／Controllerに任せる。
    return getCycleNavigatorScrollPosition(
        getComparisonCycleCount(comparison, mode),
        comparison[mode === "overlay" ? track : mode].spec,
        width,
        viewportLeft,
    );
}

/** 描画と同じ代表命令を選び、fetchがPipeline左端に見える位置へ補正する。 */
export function getInstructionNavigatorPosition(
    trace: ParsedTrace,
    spec: Readonly<KonataRenderSpec>,
    height: number,
    y: number,
): readonly [number, number] | null {
    const trackHeight = Math.floor(height);
    const metrics = new KonataRenderMetrics(trace, spec);
    const rowCount = metrics.getVisibleBottom() + 1;
    if (trackHeight <= 0 || rowCount <= 0) {
        return null;
    }
    const pixelRow = Math.min(trackHeight - 1, Math.max(0, Math.floor(y)));
    const sampleCount = Math.min(rowCount, trackHeight);
    // 描画時のfloor境界を逆算し、複数pixelに広がった同じbarからは同じOpを選ぶ。
    const sample = Math.ceil((pixelRow + 1) * sampleCount / trackHeight) - 1;
    const op = getInstructionSample(metrics, sampleCount, sample);
    if (op === undefined || op.fetchedCycle < 0) {
        return null;
    }
    // 折り返し位置や強調したbar長は実時間とは異なるため、横座標の逆変換には使わない。
    return [op.fetchedCycle, metrics.getPositionYFromOp(op)];
}

function clearNavigator(
    label: Readonly<PreparedCanvas>,
    cycleNavigator: Readonly<PreparedCanvas>,
    spec: Readonly<KonataRenderSpec>,
): BreakdownColors {
    const style = styles[spec.theme];
    label.context.fillStyle = style.labelPane.backgroundColor;
    label.context.fillRect(0, 0, label.width, label.height);
    cycleNavigator.context.fillStyle = style.pipelinePane.backgroundColor;
    cycleNavigator.context.fillRect(0, 0, cycleNavigator.width, cycleNavigator.height);
    return createBreakdownColors(
        style.pipelinePane.stageBackgroundColor,
        style.pipelinePane.backgroundColor,
    );
}

function drawCycleTrack(
    data: Readonly<CycleNavigatorData>,
    cycleNavigator: Readonly<PreparedCanvas>,
    scale: Readonly<CycleScale>,
    top: number,
    height: number,
    mode: CycleNavigatorMode,
    colors: Readonly<BreakdownColors>,
    flushedColor: string,
    activityMaximum?: number,
): void {
    const leftCycle = scale.leftCycle;
    const rightCycle = leftCycle + cycleNavigator.width / scale.pixelsPerCycle;
    const drawRange = (startCycle: number, endCycle: number, left: number, width: number) => {
        if (mode === "top-down") {
            const sample = getCycleNavigatorTopDown(
                data,
                startCycle,
                endCycle,
            );
            if (sample !== null) {
                drawBreakdown(
                    cycleNavigator.context,
                    sample,
                    colors,
                    left,
                    width,
                    top,
                    height,
                );
            }
            return;
        }
        const sample = getCycleNavigatorActivity(
            data,
            mode,
            startCycle,
            endCycle,
        );
        const maximum = activityMaximum ?? sample?.maximum ?? 0;
        if (sample === null || maximum === 0) {
            return;
        }
        const barHeight = height * sample.average / maximum;
        cycleNavigator.context.fillStyle = colors[activityInfo[mode].color];
        cycleNavigator.context.fillRect(
            left, top + height - barHeight, width, barHeight,
        );
        const flushedHeight = height * sample.flushedAverage / maximum;
        if (flushedHeight > 0) {
            // Dark／Lightの差はtheme側の色だけで吸収する。
            cycleNavigator.context.fillStyle = flushedColor;
            cycleNavigator.context.fillRect(
                left, top + height - barHeight, width, flushedHeight,
            );
        }
    };
    if (scale.pixelsPerCycle >= 1) {
        const firstCycle = Math.max(0, Math.floor(leftCycle));
        const lastCycle = Math.min(data.cycleCount, Math.ceil(rightCycle));
        for (let cycle = firstCycle; cycle < lastCycle; cycle++) {
            const startCycle = cycle;
            const endCycle = cycle + 1;
            const left = Math.max(
                0,
                (startCycle - scale.leftCycle) * scale.pixelsPerCycle,
            );
            const right = Math.min(
                cycleNavigator.width,
                (endCycle - scale.leftCycle) * scale.pixelsPerCycle,
            );
            drawRange(startCycle, endCycle, left, Math.max(1, right - left));
        }
    } else {
        for (let x = 0; x < cycleNavigator.width; x++) {
            const startCycle = Math.max(0, leftCycle + x / scale.pixelsPerCycle);
            const endCycle = Math.min(
                data.cycleCount,
                leftCycle + (x + 1) / scale.pixelsPerCycle,
            );
            if (startCycle < endCycle) {
                drawRange(startCycle, endCycle, x, 1);
            }
        }
    }
}

export function drawCycleNavigator(
    data: Readonly<CycleNavigatorData>,
    spec: Readonly<KonataRenderSpec>,
    labelCanvas: HTMLCanvasElement,
    cycleCanvas: HTMLCanvasElement,
    mode: CycleNavigatorMode = "top-down",
    showDetails = false,
    rangeMode: CycleNavigatorRangeMode = "follow",
): void {
    const source = { data, spec };
    drawComparisonCycleNavigator(
        { baseline: source, candidate: source },
        labelCanvas,
        cycleCanvas,
        "candidate",
        mode,
        showDetails,
        rangeMode,
    );
}

/** 比較時はA/B単独を全高、Overlayを共通cycle軸の上下2段で描く。 */
export function drawComparisonCycleNavigator(
    comparison: Readonly<CycleNavigatorComparison>,
    labelCanvas: HTMLCanvasElement,
    cycleCanvas: HTMLCanvasElement,
    comparisonMode: CycleNavigatorComparisonMode,
    mode: CycleNavigatorMode = "top-down",
    showDetails = false,
    rangeMode: CycleNavigatorRangeMode = "follow",
): void {
    const { baseline, candidate } = comparison;
    const overlay = comparisonMode === "overlay";
    const selected = comparisonMode === "baseline" ? baseline : candidate;
    // stage依存modeだけをCommitへ退避する。Fetch／Commitは構造なしでも比較できる。
    const effectiveMode = resolveCycleNavigatorMode(
        mode,
        ...(overlay ? [baseline.data, candidate.data] : [selected.data]),
    );
    const labelSource = overlay ? candidate : selected;
    const label = prepareCanvas(labelCanvas);
    const cycleNavigator = prepareCanvas(cycleCanvas);
    const style = styles[labelSource.spec.theme];
    const colors = clearNavigator(label, cycleNavigator, labelSource.spec);
    const activityMaximum = overlay && effectiveMode !== "top-down"
        ? Math.max(
            getCycleNavigatorActivityMaximum(baseline.data, effectiveMode),
            getCycleNavigatorActivityMaximum(candidate.data, effectiveMode),
        )
        : undefined;
    drawLabels(
        labelSource.data,
        labelSource.spec,
        label,
        colors,
        effectiveMode,
        showDetails,
        activityMaximum,
    );

    const cycleCount = getComparisonCycleCount(comparison, comparisonMode);
    const baselineHeight = Math.floor(cycleNavigator.height / 2);
    const tracks = overlay ? [
        {
            source: baseline, track: "baseline",
            top: 0, height: baselineHeight, label: "A",
        },
        {
            source: candidate, track: "candidate",
            top: baselineHeight, height: cycleNavigator.height - baselineHeight, label: "B",
        },
    ] as const : [
        {
            source: selected,
            track: comparisonMode === "baseline" ? "baseline" : "candidate",
            top: 0, height: cycleNavigator.height, label: "",
        },
    ] as const;
    for (const track of tracks) {
        drawCycleTrack(
            track.source.data,
            cycleNavigator,
            getCycleScale(
                cycleCount,
                track.source.spec,
                cycleNavigator.width,
                rangeMode,
            ),
            track.top,
            track.height,
            effectiveMode,
            colors,
            style.traceNavigator.flushedColor,
            activityMaximum,
        );
    }
    if (rangeMode === "overview") {
        for (const track of tracks) {
            drawViewport(
                cycleNavigator.context,
                getComparisonCycleNavigatorViewport(
                    comparison, comparisonMode, track.track, cycleNavigator.width,
                ),
                cycleNavigator.width,
                track.top,
                track.height,
                style.traceNavigator.viewportShadeColor,
                style.traceNavigator.viewportBorderColor,
            );
        }
    }
    if (overlay) {
        cycleNavigator.context.fillStyle = style.pipelinePane.borderColor;
        cycleNavigator.context.fillRect(0, baselineHeight, cycleNavigator.width, 1);
        cycleNavigator.context.font = `bold 10px ${style.fontFamily}`;
        cycleNavigator.context.textAlign = "left";
        cycleNavigator.context.textBaseline = "middle";
        cycleNavigator.context.fillStyle = style.pipelinePane.fontColor;
        for (const track of tracks) {
            cycleNavigator.context.fillText(
                track.label, 4, track.top + track.height / 2,
            );
        }
    }
}

function getInstructionScale(
    metrics: Readonly<KonataRenderMetrics>,
    height: number,
): number {
    const rowsPerPixel = (metrics.getVisibleBottom() + 1) / Math.max(1, height);
    // 縦1pxが縮めるPipeline上の高さと同じ比率でcycle幅も縮める。
    return Math.max(1, rowsPerPixel * metrics.opHeight / metrics.opWidth);
}

function getInstructionSample(
    metrics: Readonly<KonataRenderMetrics>,
    sampleCount: number,
    sample: number,
) {
    const rowCount = metrics.getVisibleBottom() + 1;
    const rowsPerSample = rowCount / sampleCount;
    const row = Math.min(rowCount - 1, Math.floor((sample + 0.5) * rowsPerSample));
    // 描画とdragは同じ位置・解像度を渡し、代表命令の選択はOpStoreへ任せる。
    return metrics.getVisibleOp(row, Math.log2(rowsPerSample));
}

function drawInstructionTrack(
    metrics: Readonly<KonataRenderMetrics>,
    canvas: Readonly<PreparedCanvas>,
    left: number,
    width: number,
    cyclesPerPixel: number,
    instructionColor: string,
    instructionEndpointColor: string,
    flushedColor: string,
): void {
    const height = canvas.height;
    const rowCount = metrics.getVisibleBottom() + 1;
    if (rowCount <= 0 || height <= 0 || width <= 0) {
        return;
    }
    const sampleCount = Math.min(rowCount, height);
    for (let sample = 0; sample < sampleCount; sample++) {
        const op = getInstructionSample(metrics, sampleCount, sample);
        if (op === undefined || op.fetchedCycle < 0 || op.retiredCycle < op.fetchedCycle) {
            continue;
        }
        const top = Math.floor(sample * height / sampleCount);
        const bottom = Math.max(
            top + 1, Math.floor((sample + 1) * height / sampleCount),
        );
        const rowHeight = bottom - top;
        canvas.context.fillStyle = !metrics.spec.hideFlushedOps && op.flush
            ? flushedColor
            : instructionColor;
        const startCycle = Math.floor(op.fetchedCycle / cyclesPerPixel);
        const start = ((startCycle % width) + width) % width;
        // fetch位相は全体scaleに保ち、latencyだけを固定倍率で強調する。
        const length = Math.max(
            1,
            Math.ceil(
                (op.retiredCycle - op.fetchedCycle) *
                INSTRUCTION_LATENCY_MAGNIFICATION / cyclesPerPixel,
            ),
        );
        if (length >= width) {
            canvas.context.fillRect(left, top, width, rowHeight);
            continue;
        }
        const firstLength = Math.min(length, width - start);
        canvas.context.fillRect(left + start, top, firstLength, rowHeight);
        if (firstLength < length) {
            canvas.context.fillRect(left, top, length - firstLength, rowHeight);
        }
        // 両端だけ明暗差を付け、色に意味を増やさずfetch-retire間の長さを際立たせる。
        canvas.context.fillStyle = instructionEndpointColor;
        canvas.context.fillRect(left + start, top, 1, rowHeight);
        canvas.context.fillRect(
            left + (start + length - 1) % width, top, 1, rowHeight,
        );
    }
}

function getInstructionViewport(
    metrics: Readonly<KonataRenderMetrics>,
    height: number,
    pipelineHeight: number,
): CycleNavigatorViewport | null {
    const rowCount = metrics.getVisibleBottom() + 1;
    return getViewport(
        0,
        rowCount,
        metrics.spec.position[1],
        pipelineHeight / metrics.opHeight,
        height,
    );
}

function drawInstructionViewport(
    canvas: Readonly<PreparedCanvas>,
    viewport: Readonly<CycleNavigatorViewport> | null,
    left: number,
    width: number,
    shadeColor: string,
    borderColor: string,
): void {
    if (viewport === null) {
        return;
    }
    canvas.context.fillStyle = shadeColor;
    canvas.context.fillRect(left, 0, width, viewport.left);
    canvas.context.fillRect(
        left,
        viewport.left + viewport.width,
        width,
        canvas.height - viewport.left - viewport.width,
    );
    canvas.context.fillStyle = borderColor;
    canvas.context.fillRect(left, viewport.left, width, 1);
    canvas.context.fillRect(left, viewport.left + viewport.width - 1, width, 1);
    canvas.context.fillRect(left, viewport.left, 1, viewport.width);
    canvas.context.fillRect(left + width - 1, viewport.left, 1, viewport.width);
}

export function drawInstructionNavigator(
    trace: ParsedTrace,
    spec: Readonly<KonataRenderSpec>,
    canvas: HTMLCanvasElement,
    pipelineHeight = canvas.clientHeight,
): number {
    const source = { trace, spec };
    return drawComparisonInstructionNavigator(
        { baseline: source, candidate: source }, canvas, "candidate", pipelineHeight,
    );
}

/** 比較時はA/B単独を全幅、Overlayを左右2列の独立した命令列として描く。 */
export function drawComparisonInstructionNavigator(
    comparison: Readonly<InstructionNavigatorComparison>,
    canvasElement: HTMLCanvasElement,
    mode: CycleNavigatorComparisonMode,
    pipelineHeight = canvasElement.clientHeight,
): number {
    const canvas = prepareCanvas(canvasElement);
    const selected = mode === "baseline" ? comparison.baseline : comparison.candidate;
    const style = styles[selected.spec.theme];
    canvas.context.fillStyle = style.pipelinePane.backgroundColor;
    canvas.context.fillRect(0, 0, canvas.width, canvas.height);
    const middle = Math.floor(canvas.width / 2);
    const sources = mode === "overlay"
        ? [comparison.baseline, comparison.candidate]
        : [selected];
    // 同じframeの縮尺・bar・表示範囲で、各Traceの描画寸法を共有する。
    const tracks = sources.map((source, index) => ({
        metrics: new KonataRenderMetrics(source.trace, source.spec),
        left: index === 0 ? 0 : middle,
        width: mode !== "overlay" ? canvas.width
            : index === 0 ? middle : canvas.width - middle,
    }));
    const cyclesPerPixel = Math.max(...tracks.map((track) =>
        getInstructionScale(track.metrics, canvas.height)));
    tracks.forEach((track) => {
        drawInstructionTrack(
            track.metrics,
            canvas,
            track.left,
            track.width,
            cyclesPerPixel,
            style.traceNavigator.instructionColor,
            style.traceNavigator.instructionEndpointColor,
            style.traceNavigator.flushedColor,
        );
        drawInstructionViewport(
            canvas,
            getInstructionViewport(
                track.metrics,
                canvas.height,
                pipelineHeight,
            ),
            track.left,
            track.width,
            style.traceNavigator.instructionViewportShadeColor,
            style.traceNavigator.viewportBorderColor,
        );
    });
    if (mode === "overlay") {
        canvas.context.fillStyle = style.pipelinePane.borderColor;
        canvas.context.fillRect(middle, 0, 1, canvas.height);
    }
    return cyclesPerPixel;
}
