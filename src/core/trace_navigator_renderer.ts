/** Top-down-likeの集計結果をtrace navigatorのcycle方向Canvasへ描画する。 */
import darkStyle from "../../theme/dark/style.json";
import lightStyle from "../../theme/light/style.json";
import {
    getTopDownBreakdown,
    type TopDownBreakdown,
    type TopDownData,
} from "./top_down_analysis";
import {
    getKonataZoomScale,
    KONATA_OP_WIDTH,
    type KonataRenderSpec,
    type RendererTheme,
} from "./konata_renderer";

// 縮小表示ではOp描画と同じくglobal cycleへ揃えた代表点だけを見る。各cycle内では
// 全allocation slotを数えるため、slot位置によるcategory比率の偏りは作らない。
const MAX_SAMPLED_CYCLES_PER_PIXEL = 64;

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
}

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

function getColors(theme: RendererTheme): BreakdownColors {
    // Top-down categoryはstageではないため、stage paletteから独立したsemantic colorを使う。
    return theme === "light"
        ? {
            retiring: "#2e7d32",
            badSpeculation: "#c62828",
            frontendBound: "#1565c0",
            backendBound: "#ef6c00",
            unresolved: "#616161",
        }
        : {
            retiring: "#66bb6a",
            badSpeculation: "#ef5350",
            frontendBound: "#42a5f5",
            backendBound: "#ffa726",
            unresolved: "#b0bec5",
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
        [sample.retiringSlots, colors.retiring],
        [sample.squashedSlots + sample.recoveryBubbleSlots, colors.badSpeculation],
        [sample.frontendBound, colors.frontendBound],
        [sample.backendBound, colors.backendBound],
        [sample.unresolvedSlots, colors.unresolved],
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
): void {
    const { analysis } = data;
    const style = spec.theme === "light" ? lightStyle : darkStyle;
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
        ["Retiring", colors.retiring],
        ["Bad speculation", colors.badSpeculation],
        ["Frontend bound", colors.frontendBound],
        ["Backend bound", colors.backendBound],
        ["Unresolved", colors.unresolved],
    ] as const;
    const columnWidth = Math.max(100, (canvas.width - margin * 2) / 3);
    legends.forEach(([label, color], index) => {
        const left = margin + index % 3 * columnWidth;
        const center = 72 + Math.floor(index / 3) * 22;
        context.fillStyle = color;
        context.fillRect(left, center - 5, 10, 10);
        context.fillStyle = style.labelPane.fontColor;
        context.fillText(label, left + 15, center, columnWidth - 18);
    });
}

export function getTopDownBreakdownAtPixel(
    data: Readonly<TopDownData>,
    spec: Readonly<KonataRenderSpec>,
    x: number,
    width: number,
): TopDownBreakdown | null {
    if (x < 0 || x >= width) {
        return null;
    }
    const cycle = spec.position[0] + x /
        (KONATA_OP_WIDTH * getKonataZoomScale(spec.zoomLevel));
    if (cycle < 0 || cycle >= data.cycleCount) {
        return null;
    }
    const opWidth = KONATA_OP_WIDTH * getKonataZoomScale(spec.zoomLevel);
    if (opWidth >= 1) {
        const startCycle = Math.floor(cycle);
        return getTopDownBreakdown(data, startCycle, startCycle + 1);
    }
    return getTopDownBreakdown(
        data,
        cycle,
        spec.position[0] + (x + 1) / opWidth,
        MAX_SAMPLED_CYCLES_PER_PIXEL,
    );
}

export function drawCycleNavigator(
    data: Readonly<TopDownData>,
    spec: Readonly<KonataRenderSpec>,
    labelCanvas: HTMLCanvasElement,
    cycleCanvas: HTMLCanvasElement,
): void {
    const label = prepareCanvas(labelCanvas);
    const cycleNavigator = prepareCanvas(cycleCanvas);
    const style = spec.theme === "light" ? lightStyle : darkStyle;
    label.context.fillStyle = style.labelPane.backgroundColor;
    label.context.fillRect(0, 0, label.width, label.height);
    cycleNavigator.context.fillStyle = style.pipelinePane.backgroundColor;
    cycleNavigator.context.fillRect(0, 0, cycleNavigator.width, cycleNavigator.height);
    const colors = getColors(spec.theme);
    drawLabels(data, spec, label, colors);
    if (data.analysis === null) {
        return;
    }

    const opWidth = KONATA_OP_WIDTH * getKonataZoomScale(spec.zoomLevel);
    const leftCycle = spec.position[0];
    const rightCycle = leftCycle + cycleNavigator.width / opWidth;
    if (opWidth >= 1) {
        const firstCycle = Math.max(0, Math.floor(leftCycle));
        const lastCycle = Math.min(data.cycleCount, Math.ceil(rightCycle));
        for (let cycle = firstCycle; cycle < lastCycle; cycle++) {
            const startCycle = cycle;
            const endCycle = cycle + 1;
            const sample = getTopDownBreakdown(data, startCycle, endCycle);
            if (sample !== null) {
                const left = Math.max(0, (startCycle - leftCycle) * opWidth);
                const right = Math.min(cycleNavigator.width, (endCycle - leftCycle) * opWidth);
                drawBreakdown(cycleNavigator.context, sample, colors, left,
                    Math.max(1, right - left), cycleNavigator.height);
            }
        }
        return;
    }

    for (let x = 0; x < cycleNavigator.width; x++) {
        const startCycle = Math.max(0, leftCycle + x / opWidth);
        const endCycle = Math.min(data.cycleCount, leftCycle + (x + 1) / opWidth);
        const sample = getTopDownBreakdown(
            data, startCycle, endCycle, MAX_SAMPLED_CYCLES_PER_PIXEL,
        );
        if (sample !== null) {
            drawBreakdown(cycleNavigator.context, sample, colors, x, 1, cycleNavigator.height);
        }
    }
}
