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
const styles = { light: lightStyle, dark: darkStyle };

export type CycleNavigatorMode = "top-down" | CycleActivityMode;

interface PixelCycleRange {
    readonly startCycle: number;
    readonly endCycle: number;
    readonly maxSampleCycles: number;
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
        title: "Fetch throughput", detail: "Fetched ops/cycle",
        toolTipTitle: "Fetch throughput", unit: " ops/cycle", color: "frontendBound",
    },
    issue: {
        title: "Issue throughput", detail: "starts/cycle",
        toolTipTitle: "Issue throughput", unit: " ops/cycle", color: "backendBound",
    },
    commit: {
        title: "Commit throughput", detail: "Retired ops/cycle",
        toolTipTitle: "Commit throughput (retired ops)", unit: " ops/cycle", color: "retiring",
    },
    flush: {
        title: "Flushed work", detail: "Flushed ops allocated/cycle",
        toolTipTitle: "Flushed work (at allocation)", unit: " ops/cycle", color: "flush",
    },
    latency: {
        title: "Issue-to-completion latency", detail: "completion latency/cycle",
        toolTipTitle: "Issue-to-completion latency", unit: " cycles", color: "latency",
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

function drawLabels(
    data: Readonly<TopDownData>,
    spec: Readonly<KonataRenderSpec>,
    canvas: Readonly<PreparedCanvas>,
    colors: Readonly<BreakdownColors>,
    mode: CycleNavigatorMode,
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
        context.fillText("Top-down-like view unavailable", margin, 18);
        context.fillText("No allocation boundary was inferred for this trace.", margin, 38);
        return;
    }

    const format = (value: number) => Number.isInteger(value)
        ? value.toString()
        : value.toFixed(1);
    if (mode !== "top-down") {
        const activity = analysis.cycleActivity;
        const series = activity[mode];
        const info = activityInfo[mode];
        const detail = mode === "issue"
            ? `${analysis.executionStage.label} ${info.detail}`
            : mode === "latency"
                ? `Maximum ${analysis.executionStage.label} → ${info.detail}`
                : info.detail;
        const maximum = series.maximum >= 255 ? "≥255" : format(series.maximum);
        const unit = mode === "latency" ? " cycles" : "/c";
        const flushed = mode === "fetch" || mode === "issue"
            ? " · shaded = later flushed"
            : "";
        context.fillText(info.title, margin, 18);
        context.fillText(
            `${detail} · observed max ${maximum}${unit}${flushed}`,
            margin,
            42,
        );
        return;
    }

    context.fillText("Top-down-like (auto)", margin, 13);
    context.fillText(
        `Allocation ${analysis.allocationStage.label} · width ≥${format(analysis.allocationWidth)}/c`,
        margin,
        31,
    );
    const admission = analysis.admissionStages.slice(0, 2)
        .map((entry) => `${entry.stage.label} +${format(entry.typicalLatency)}c`)
        .join(", ");
    const entrance = admission === "" ? "" : ` · entrance ${admission}`;
    const recovery = analysis.recoveryWindowCount === 0
        ? ""
        : analysis.minimumRecoveryCycles === null
            ? ` · recovery ${analysis.recoveryWindowCount}`
            : ` · recovery ${analysis.recoveryWindowCount}, +${format(analysis.minimumRecoveryCycles)}c min`;
    context.fillText(
        `Before ${analysis.executionStage.label}${entrance}${recovery} · ${(analysis.transitionCoverage * 100).toFixed(0)}% links`,
        margin,
        49,
    );

    const legends = [
        ["Bad speculation", colors.badSpeculation],
        ["Frontend bound", colors.frontendBound],
        ["Backend bound", colors.backendBound],
        ["Unresolved", colors.unresolved],
        ["Retiring", colors.retiring],
    ] as const;
    const columnWidth = Math.max(100, (canvas.width - margin * 2) / 3);
    legends.forEach(([label, color], index) => {
        const left = margin + index % 3 * columnWidth;
        const center = 72 + Math.floor(index / 3) * 22;
        context.fillStyle = color;
        context.fillRect(left, center - 5, 10, 10);
        if (color === colors.unresolved) {
            context.strokeStyle = style.labelPane.fontColor;
            context.lineWidth = 1;
            context.strokeRect(left + 0.5, center - 4.5, 9, 9);
        }
        context.fillStyle = style.labelPane.fontColor;
        context.fillText(label, left + 15, center, columnWidth - 18);
    });
}

function getPixelCycleRange(
    data: Readonly<TopDownData>,
    spec: Readonly<KonataRenderSpec>,
    x: number,
    width: number,
): PixelCycleRange | null {
    if (x < 0 || x >= width) {
        return null;
    }
    const opWidth = KONATA_OP_WIDTH * getKonataZoomScale(spec.zoomLevel);
    const cycle = spec.position[0] + x / opWidth;
    if (cycle < 0 || cycle >= data.cycleCount) {
        return null;
    }
    return opWidth >= 1
        ? {
            startCycle: Math.floor(cycle),
            endCycle: Math.floor(cycle) + 1,
            maxSampleCycles: Number.POSITIVE_INFINITY,
        }
        : {
            startCycle: cycle,
            endCycle: spec.position[0] + (x + 1) / opWidth,
            maxSampleCycles: MAX_SAMPLED_CYCLES_PER_PIXEL,
        };
}

export function getCycleNavigatorToolTip(
    data: Readonly<TopDownData>,
    mode: CycleNavigatorMode,
    spec: Readonly<KonataRenderSpec>,
    x: number,
    width: number,
): string | null {
    const range = getPixelCycleRange(data, spec, x, width);
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
        ? `${info.toolTipTitle} (${analysis.executionStage.label})`
        : info.toolTipTitle;
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
    drawLabels(data, spec, label, colors, mode);
    const analysis = data.analysis;
    if (analysis === null) {
        return;
    }

    const opWidth = KONATA_OP_WIDTH * getKonataZoomScale(spec.zoomLevel);
    const leftCycle = spec.position[0];
    const rightCycle = leftCycle + cycleNavigator.width / opWidth;
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
    if (opWidth >= 1) {
        const firstCycle = Math.max(0, Math.floor(leftCycle));
        const lastCycle = Math.min(data.cycleCount, Math.ceil(rightCycle));
        for (let cycle = firstCycle; cycle < lastCycle; cycle++) {
            const startCycle = cycle;
            const endCycle = cycle + 1;
            const left = Math.max(0, (startCycle - leftCycle) * opWidth);
            const right = Math.min(cycleNavigator.width, (endCycle - leftCycle) * opWidth);
            drawRange(startCycle, endCycle, left, Math.max(1, right - left));
        }
        return;
    }

    for (let x = 0; x < cycleNavigator.width; x++) {
        const startCycle = Math.max(0, leftCycle + x / opWidth);
        const endCycle = Math.min(data.cycleCount, leftCycle + (x + 1) / opWidth);
        drawRange(startCycle, endCycle, x, 1);
    }
}
