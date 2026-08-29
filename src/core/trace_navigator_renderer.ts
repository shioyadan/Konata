/** Top-down-like分類またはcycle activityをNavigatorのcycle方向Canvasへ描画する。 */
import darkStyle from "../../theme/dark/style.json";
import lightStyle from "../../theme/light/style.json";
import {
    getCycleActivity,
    type CycleActivityMode,
} from "./cycle_activity_analysis";
import {
    getTopDownBreakdown,
    type TopDownBreakdown,
    type TopDownData,
} from "./top_down_analysis";
import {
    getKonataZoomScale,
    KONATA_OP_WIDTH,
    type KonataRenderSpec,
} from "./konata_renderer";

// 縮小表示ではOp描画と同じくglobal cycleへ揃えた代表点だけを見る。各cycle内では
// 全allocation slotを数えるため、slot位置によるcategory比率の偏りは作らない。
const MAX_SAMPLED_CYCLES_PER_PIXEL = 64;
const MIN_VIEWPORT_WIDTH = 8;
const styles = { light: lightStyle, dark: darkStyle };

export type CycleNavigatorMode = "top-down" | CycleActivityMode;
export type CycleNavigatorRangeMode = "follow" | "overview";

export interface CycleNavigatorViewport {
    readonly left: number;
    readonly width: number;
}

interface PixelCycleRange {
    readonly startCycle: number;
    readonly endCycle: number;
    readonly maxSampleCycles: number;
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
    fetch: {
        title: "Fetch throughput", unit: " ops/cycle", color: "frontendBound",
    },
    issue: {
        title: "Issue throughput", unit: " ops/cycle", color: "backendBound",
    },
    commit: {
        title: "Commit throughput (retired ops)", unit: " ops/cycle", color: "retiring",
    },
    flush: {
        title: "Flushed work (at allocation)", unit: " ops/cycle", color: "flush",
    },
    latency: {
        title: "Issue-to-completion latency", unit: " cycles", color: "latency",
    },
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
    sample: Readonly<TopDownBreakdown>,
    colors: Readonly<BreakdownColors>,
    left: number,
    width: number,
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
    let top = 0;
    for (const [value, color] of segments) {
        const segmentHeight = height * value / sample.totalSlots;
        if (segmentHeight > 0) {
            context.fillStyle = color;
            context.fillRect(left, top, width, segmentHeight);
        }
        top += segmentHeight;
    }
}

function drawViewport(
    context: CanvasRenderingContext2D,
    viewport: Readonly<CycleNavigatorViewport>,
    width: number,
    height: number,
    shadeColor: string,
    borderColor: string,
): void {
    const right = Math.min(width, viewport.left + viewport.width);
    context.fillStyle = shadeColor;
    context.fillRect(0, 0, viewport.left, height);
    context.fillRect(right, 0, Math.max(0, width - right), height);
    context.strokeStyle = borderColor;
    context.lineWidth = 1;
    context.strokeRect(
        viewport.left + 0.5,
        0.5,
        Math.max(0, right - viewport.left - 1),
        Math.max(0, height - 1),
    );
}

function drawLabels(
    data: Readonly<TopDownData>,
    spec: Readonly<KonataRenderSpec>,
    canvas: Readonly<PreparedCanvas>,
    colors: Readonly<BreakdownColors>,
    mode: CycleNavigatorMode,
    showDetails: boolean,
): void {
    const { analysis } = data;
    const style = styles[spec.theme];
    const margin = Number(style.labelPane.marginLeft);
    const { context } = canvas;
    context.font = `${style.fontStyle} 12px ${style.fontFamily}`;
    context.textAlign = "left";
    context.textBaseline = "middle";
    context.fillStyle = style.labelPane.fontColor;
    if (analysis === null) {
        context.fillText("Analysis unavailable", margin, 34);
        context.fillText("No allocation boundary detected.", margin, 52);
        return;
    }

    const format = (value: number) => Number.isInteger(value)
        ? value.toString()
        : value.toFixed(1);
    const detailLeft = 128;
    const detailCenter = 16;
    if (mode !== "top-down") {
        if (!showDetails) {
            return;
        }
        const series = analysis.cycleActivity[mode];
        const info = activityInfo[mode];
        const prefix = mode === "issue"
            ? `${analysis.executionStage.label} · `
            : mode === "latency"
                ? `${analysis.executionStage.label} → completion · `
                : "";
        const maximum = series.maximum >= 255 ? "≥255" : format(series.maximum);
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

    const legendWidth = 64;
    const legendLeft = Math.max(margin, canvas.width - margin - legendWidth);
    if (showDetails) {
        context.font = `${style.fontStyle} 11px ${style.fontFamily}`;
        context.fillText(
            `AUTO · ${analysis.allocationStage.label} ` +
                `≥${format(analysis.allocationWidth)}/c → ${analysis.executionStage.label}`,
            detailLeft,
            detailCenter,
            Math.max(1, legendLeft - detailLeft - 10),
        );
    }

    const legends = [
        ["Bad", colors.badSpeculation],
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
    data: Readonly<TopDownData>,
    spec: Readonly<KonataRenderSpec>,
    width: number,
    rangeMode: CycleNavigatorRangeMode,
): CycleScale {
    if (rangeMode === "overview") {
        return {
            leftCycle: 0,
            pixelsPerCycle: width / Math.max(1, data.cycleCount),
        };
    }
    return {
        leftCycle: spec.position[0],
        pixelsPerCycle: KONATA_OP_WIDTH * getKonataZoomScale(spec.zoomLevel),
    };
}

function getPixelCycleRange(
    data: Readonly<TopDownData>,
    spec: Readonly<KonataRenderSpec>,
    x: number,
    width: number,
    rangeMode: CycleNavigatorRangeMode,
): PixelCycleRange | null {
    if (x < 0 || x >= width) {
        return null;
    }
    const scale = getCycleScale(data, spec, width, rangeMode);
    const cycle = scale.leftCycle + x / scale.pixelsPerCycle;
    if (cycle < 0 || cycle >= data.cycleCount) {
        return null;
    }
    return scale.pixelsPerCycle >= 1
        ? {
            startCycle: Math.floor(cycle),
            endCycle: Math.floor(cycle) + 1,
            maxSampleCycles: Number.POSITIVE_INFINITY,
        }
        : {
            startCycle: cycle,
            endCycle: scale.leftCycle + (x + 1) / scale.pixelsPerCycle,
            maxSampleCycles: MAX_SAMPLED_CYCLES_PER_PIXEL,
        };
}

/** Overview上で、現在のPipeline表示範囲に対応するscrollbar thumbを返す。 */
export function getCycleNavigatorViewport(
    data: Readonly<TopDownData>,
    spec: Readonly<KonataRenderSpec>,
    width: number,
): CycleNavigatorViewport | null {
    if (width <= 0 || data.cycleCount <= 0) {
        return null;
    }
    const pixelsPerCycle = KONATA_OP_WIDTH * getKonataZoomScale(spec.zoomLevel);
    const visibleCycles = width / pixelsPerCycle;
    if (visibleCycles >= data.cycleCount) {
        return { left: 0, width };
    }
    const viewportWidth = Math.min(
        width,
        Math.max(MIN_VIEWPORT_WIDTH, width * visibleCycles / data.cycleCount),
    );
    const maximumCycle = data.cycleCount - visibleCycles;
    const position = Math.min(Math.max(spec.position[0], 0), maximumCycle);
    return {
        left: position / maximumCycle * (width - viewportWidth),
        width: viewportWidth,
    };
}

/** Overviewのthumb左端を、Pipeline左端のcycleへ戻す。 */
export function getCycleNavigatorScrollPosition(
    data: Readonly<TopDownData>,
    spec: Readonly<KonataRenderSpec>,
    width: number,
    viewportLeft: number,
): number | null {
    const viewport = getCycleNavigatorViewport(data, spec, width);
    if (viewport === null) {
        return null;
    }
    const trackWidth = width - viewport.width;
    if (trackWidth <= 0) {
        return 0;
    }
    const pixelsPerCycle = KONATA_OP_WIDTH * getKonataZoomScale(spec.zoomLevel);
    const maximumCycle = data.cycleCount - width / pixelsPerCycle;
    return Math.min(Math.max(viewportLeft, 0), trackWidth) / trackWidth * maximumCycle;
}

export function getCycleNavigatorToolTip(
    data: Readonly<TopDownData>,
    mode: CycleNavigatorMode,
    spec: Readonly<KonataRenderSpec>,
    x: number,
    width: number,
    rangeMode: CycleNavigatorRangeMode = "follow",
): string | null {
    const range = getPixelCycleRange(data, spec, x, width, rangeMode);
    if (range === null) {
        return null;
    }
    if (mode === "top-down") {
        const sample = getTopDownBreakdown(
            data, range.startCycle, range.endCycle, range.maxSampleCycles,
        );
        if (sample === null) {
            return null;
        }
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
        return [
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

    const analysis = data.analysis;
    if (analysis === null) {
        return null;
    }
    const sample = getCycleActivity(
        analysis.cycleActivity,
        data.cycleCount,
        mode,
        range.startCycle,
        range.endCycle,
        range.maxSampleCycles,
    );
    if (sample === null) {
        return null;
    }
    const info = activityInfo[mode];
    const title = mode === "issue"
        ? `${info.title} (${analysis.executionStage.label})`
        : info.title;
    return [
        title,
        `Cycles: ${sample.startCycle}–${sample.endCycle - 1}`,
        `Average: ${sample.average.toFixed(2)}${info.unit}`,
        ...(sample.flushedAverage === 0
            ? []
            : [`Later flushed: ${sample.flushedAverage.toFixed(2)} ops/cycle`]),
        `Observed trace maximum: ${sample.maximum}${info.unit}`,
        ...(sample.samplingStride === 1
            ? []
            : [`Sampled every ${sample.samplingStride} cycles`]),
        ...(mode === "latency" ? [] : ["Ops/cycle is not necessarily architectural IPC."]),
    ].join("\n");
}

export function drawCycleNavigator(
    data: Readonly<TopDownData>,
    spec: Readonly<KonataRenderSpec>,
    labelCanvas: HTMLCanvasElement,
    cycleCanvas: HTMLCanvasElement,
    mode: CycleNavigatorMode = "top-down",
    showDetails = false,
    rangeMode: CycleNavigatorRangeMode = "follow",
): void {
    const label = prepareCanvas(labelCanvas);
    const cycleNavigator = prepareCanvas(cycleCanvas);
    const style = styles[spec.theme];
    label.context.fillStyle = style.labelPane.backgroundColor;
    label.context.fillRect(0, 0, label.width, label.height);
    cycleNavigator.context.fillStyle = style.pipelinePane.backgroundColor;
    cycleNavigator.context.fillRect(0, 0, cycleNavigator.width, cycleNavigator.height);
    const colors = createBreakdownColors(
        style.pipelinePane.stageBackgroundColor,
        style.pipelinePane.backgroundColor,
    );
    drawLabels(data, spec, label, colors, mode, showDetails);
    const analysis = data.analysis;
    if (analysis === null) {
        return;
    }

    const scale = getCycleScale(data, spec, cycleNavigator.width, rangeMode);
    const leftCycle = scale.leftCycle;
    const rightCycle = leftCycle + cycleNavigator.width / scale.pixelsPerCycle;
    const drawRange = (startCycle: number, endCycle: number, left: number, width: number) => {
        if (mode === "top-down") {
            const sample = getTopDownBreakdown(
                data,
                startCycle,
                endCycle,
                MAX_SAMPLED_CYCLES_PER_PIXEL,
            );
            if (sample !== null) {
                drawBreakdown(
                    cycleNavigator.context,
                    sample,
                    colors,
                    left,
                    width,
                    cycleNavigator.height,
                );
            }
            return;
        }
        const sample = getCycleActivity(
            analysis.cycleActivity,
            data.cycleCount,
            mode,
            startCycle,
            endCycle,
            MAX_SAMPLED_CYCLES_PER_PIXEL,
        );
        if (sample === null || sample.maximum === 0) {
            return;
        }
        const height = cycleNavigator.height * sample.average / sample.maximum;
        cycleNavigator.context.fillStyle = colors[activityInfo[mode].color];
        cycleNavigator.context.fillRect(
            left, cycleNavigator.height - height, width, height,
        );
        const flushedHeight = cycleNavigator.height * sample.flushedAverage / sample.maximum;
        if (flushedHeight > 0) {
            // Dark／Lightの差はtheme側の色だけで吸収する。
            cycleNavigator.context.fillStyle = style.traceNavigator.flushedColor;
            cycleNavigator.context.fillRect(
                left, cycleNavigator.height - height, width, flushedHeight,
            );
        }
    };
    if (scale.pixelsPerCycle >= 1) {
        const firstCycle = Math.max(0, Math.floor(leftCycle));
        const lastCycle = Math.min(data.cycleCount, Math.ceil(rightCycle));
        for (let cycle = firstCycle; cycle < lastCycle; cycle++) {
            const startCycle = cycle;
            const endCycle = cycle + 1;
            const left = Math.max(0, (startCycle - leftCycle) * scale.pixelsPerCycle);
            const right = Math.min(
                cycleNavigator.width,
                (endCycle - leftCycle) * scale.pixelsPerCycle,
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
            drawRange(startCycle, endCycle, x, 1);
        }
    }
    if (rangeMode === "overview") {
        const viewport = getCycleNavigatorViewport(data, spec, cycleNavigator.width);
        if (viewport !== null) {
            drawViewport(
                cycleNavigator.context,
                viewport,
                cycleNavigator.width,
                cycleNavigator.height,
                style.traceNavigator.viewportShadeColor,
                style.traceNavigator.viewportBorderColor,
            );
        }
    }
}
