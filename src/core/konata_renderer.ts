import type { Op, ParsedTrace } from "./model";
import {
    CanvasBackend,
    type CanvasDrawContext,
} from "./canvas_backend";

// fsで読むと配布後のcurrent directoryに依存するため、旧Rendererと同じく
// style定義はmoduleとしてbundleへ取り込む。
import darkStyle from "../../theme/dark/style.json";
import lightStyle from "../../theme/light/style.json";

// Traceと組み合わせて描画結果を再現するための、Canvasに依存しない正式入力を定義する。
// UIとStoreはRenderer instanceではなくこの値を共有し、表示設定や描画位置を保持する。

export const DEP_ARROW_TYPE = {
    INSIDE_LINE: "insideLine",
    LEFT_SIDE_CURVE: "leftSideCurve",
    NOT_SHOW: "notShow",
} as const;

export type DependencyArrowType = typeof DEP_ARROW_TYPE[keyof typeof DEP_ARROW_TYPE];
export type RendererTheme = "dark" | "light";

export type CustomColorComponent = number | "auto";

export interface CustomColorDefinition {
    readonly h: number;
    readonly s: CustomColorComponent;
    readonly l: CustomColorComponent;
}

export interface CustomColorScheme {
    readonly defaultColor: CustomColorDefinition;
    readonly [laneName: string]:
        CustomColorDefinition | Readonly<Record<string, CustomColorDefinition>>;
}

// 旧Configが既定で持っていたCustom schemeを、そのままWeb版でも選択できるようにする。
export const DEFAULT_CUSTOM_COLOR_SCHEME: Readonly<CustomColorScheme> = {
    defaultColor: { h: 100, s: "auto", l: "auto" },
    "0": {
        F: { h: 0, s: "auto", l: "auto" },
        Rn: { h: 60, s: "auto", l: "auto" },
        Dc: { h: 120, s: "auto", l: "auto" },
        Is: { h: 180, s: "auto", l: "auto" },
        Cm: { h: 240, s: "auto", l: "auto" },
        f: { h: 0, s: 0, l: "auto" },
    },
    "1": {
        stl: { h: 0, s: 0, l: "auto" },
    },
};

/**
 * KonataRendererへ渡す再現可能な描画指定。
 *
 * Traceとこの値が同じなら、Canvasの寸法とdevicePixelRatioを除く描画結果も同じになる。
 * Canvas寸法はDOM layoutの結果なのでここへ含めず、TraceSheetが描画時に与える。
 */
export interface KonataRenderSpec {
    readonly position: readonly [number, number];
    readonly zoomLevel: number;
    readonly theme: RendererTheme;
    readonly colorScheme: string;
    readonly customColorScheme: Readonly<CustomColorScheme>;
    readonly dependencyArrowType: DependencyArrowType;
    readonly splitLanes: boolean;
    readonly fixOpHeight: boolean;
    readonly hideFlushedOps: boolean;
    readonly textLabelMinimumLaneHeight: number;
    readonly stageDetailMinimumLaneHeight: number;
    readonly dependencyArrowMinimumLaneHeight: number;
    readonly stageBorderMinimumLaneHeight: number;
}

// 表示操作で変化する部分だけを、完全な描画指定と同じfield定義から取り出す。
export type KonataView = Readonly<Pick<KonataRenderSpec, "position" | "zoomLevel">>;

export function getKonataView(spec: KonataView): KonataView {
    return { position: spec.position, zoomLevel: spec.zoomLevel };
}

// pipeline全体、cache可能な本体、タイルを横断する依存矢印を同じ描画実装から選べるようにする。
// passは描画内容を別実装へ複製するためではなく、元のpainter順を保ったままcache境界だけを作る。
export type KonataPipelinePass = "all" | "base" | "dependencies";

const ZOOM_RATIO = 1;
const MAX_ZOOM_LEVEL = 24;

export const DEFAULT_KONATA_RENDER_SPEC: Readonly<KonataRenderSpec> = {
    position: [0, 0],
    zoomLevel: 0,
    theme: "dark",
    colorScheme: "Auto",
    customColorScheme: DEFAULT_CUSTOM_COLOR_SCHEME,
    dependencyArrowType: DEP_ARROW_TYPE.INSIDE_LINE,
    splitLanes: false,
    fixOpHeight: false,
    hideFlushedOps: false,
    textLabelMinimumLaneHeight: 10,
    stageDetailMinimumLaneHeight: 0.5,
    dependencyArrowMinimumLaneHeight: 4,
    stageBorderMinimumLaneHeight: 4,
};

export function clampKonataZoomLevel(zoomLevel: number): number {
    return Math.max(-1, Math.min(MAX_ZOOM_LEVEL, zoomLevel));
}

export function getKonataZoomScale(zoomLevel: number): number {
    return 2 ** (-zoomLevel * ZOOM_RATIO);
}

export function formatKonataZoomPercent(zoomLevel: number): string {
    const percent = getKonataZoomScale(zoomLevel) * 100;
    // 大幅に縮小しても0%に丸めず、ツールバー内に収まる桁数で倍率を示す。
    const value = percent >= 0.01
        ? Number(percent.toPrecision(3)).toString()
        : percent.toExponential(1);
    return `${value}%`;
}

// TraceとKonataRenderSpecから、描画寸法・座標変換・hit testを純粋に計算する。
// CanvasやDOMを参照せず、同じ入力から常に同じ結果を返す派生値だけを持つ。


export const KONATA_OP_WIDTH = 32;
export const KONATA_OP_HEIGHT = 24;
export const KONATA_LANE_HEIGHT_MARGIN = 2;

export class KonataRenderMetrics {
    readonly zoomLevel: number;
    readonly zoomScale: number;
    readonly laneNum: number;
    readonly laneWidth: number;
    readonly laneHeight: number;
    readonly opWidth: number;
    readonly opHeight: number;
    readonly laneHeightMargin: number;
    readonly drawingInterval: number;
    readonly canDrawDetailedly: boolean;
    readonly canDrawDependency: boolean;
    readonly canDrawFrame: boolean;
    readonly canDrawText: boolean;

    constructor(
        readonly trace: ParsedTrace | null,
        readonly spec: Readonly<KonataRenderSpec>,
    ) {
        this.zoomLevel = clampKonataZoomLevel(spec.zoomLevel);
        this.zoomScale = getKonataZoomScale(this.zoomLevel);
        this.laneNum = trace?.stageLevelMap.laneNum ?? 1;
        const visibleLaneNum = spec.splitLanes && this.laneNum !== 0 ? this.laneNum : 1;
        this.laneWidth = KONATA_OP_WIDTH * this.zoomScale;
        this.opWidth = this.laneWidth;
        if (spec.fixOpHeight) {
            this.laneHeight = KONATA_OP_HEIGHT * this.zoomScale / visibleLaneNum;
            this.opHeight = this.laneHeight * visibleLaneNum;
        }
        else {
            this.laneHeight = KONATA_OP_HEIGHT * this.zoomScale;
            this.opHeight = this.laneHeight * visibleLaneNum;
        }

        // 枠を描けるかを既定marginから一度で決め、直前に描いたSpecへの隠れた依存をなくす。
        const margin = KONATA_LANE_HEIGHT_MARGIN * this.zoomScale;
        this.canDrawFrame = this.laneHeight - margin * 2 > spec.stageBorderMinimumLaneHeight;
        this.laneHeightMargin = this.canDrawFrame ? margin : 0;
        const contentHeight = this.laneHeight - this.laneHeightMargin * 2;
        this.canDrawDetailedly = contentHeight > spec.stageDetailMinimumLaneHeight;
        this.canDrawDependency = contentHeight > spec.dependencyArrowMinimumLaneHeight;
        this.canDrawText = contentHeight > spec.textLabelMinimumLaneHeight;
        this.drawingInterval = Math.floor(1 / KONATA_OP_HEIGHT / this.zoomScale / 2);
    }

    // 縦方向は24px/opなので、2^5より小さくなった時だけ取得解像度を落とす。
    get opResolution(): number {
        return this.zoomLevel - 5;
    }

    // 1 pixel未満へ多数の命令が重なる縮小域では、旧Rendererと同じ間隔で代表命令だけを見る。
    // タイルの空判定もこの値を使い、実描画が取得しない命令を余分に走査しない。
    get drawingStep(): number {
        return this.opHeight < 0.25 ? Math.max(1, this.drawingInterval) : 1;
    }

    getVisibleOp(y: number, resolution = 0): Op | undefined {
        return this.spec.hideFlushedOps
            ? this.getOpFromRID(y, resolution)
            : this.getOpFromID(y, resolution);
    }

    getVisibleBottom(): number {
        if (this.trace === null) {
            return 0;
        }
        return this.spec.hideFlushedOps ? this.trace.lastRID : this.trace.lastID;
    }

    getPositionYFromRID(rid: number): number {
        if (this.spec.hideFlushedOps) {
            return rid;
        }
        return this.getOpFromRID(rid)?.id ?? -1;
    }

    getPositionYFromOp(baseOp: Op): number {
        if (!this.spec.hideFlushedOps) {
            return baseOp.id;
        }
        for (let id = baseOp.id; id >= 0; id--) {
            const op = this.getOpFromID(id);
            if (op !== undefined && !op.flush) {
                return op.rid;
            }
        }
        return 0;
    }

    getOpFromID(id: number, resolution = 0): Op | undefined {
        return this.trace?.getOp(id, resolution);
    }

    getOpFromRID(rid: number, resolution = 0): Op | undefined {
        return this.trace?.getOpFromRID(rid, resolution);
    }

    getOpFromPixelPositionY(y: number, resolution = 0): Op | undefined {
        const logicalY = Math.floor(this.spec.position[1] + y / this.opHeight);
        return this.getVisibleOp(logicalY, resolution);
    }

    getPixelPositionYFromOp(op: Op): number {
        const y = this.spec.hideFlushedOps ? op.rid : op.id;
        return (y - this.spec.position[1]) * this.opHeight;
    }

    getPixelPositionYFromID(id: number): number {
        const op = this.getOpFromID(id);
        return op === undefined ? 0 : this.getPixelPositionYFromOp(op);
    }

    getCycleFromPixelPositionX(x: number): number {
        return Math.floor(this.spec.position[0] + x / this.opWidth);
    }

    getAdjustedViewPosition(): readonly [number, number] | null {
        if (this.trace === null) {
            return null;
        }

        const top = this.spec.position[1];
        let op: Op | undefined;
        if (top < 0) {
            op = this.getOpFromID(0);
        }
        else if (top > this.getVisibleBottom()) {
            // 旧版と同じく末尾に余白を残しつつ、短いtraceでも先頭へ復帰できるようにする。
            op = this.getVisibleOp(Math.max(0, this.getVisibleBottom() - 30));
        }
        else {
            op = this.getOpFromPixelPositionY(0);
        }
        if (op === undefined) {
            return null;
        }

        // flushされた命令よりRIDに対応するretire済み命令を優先する。
        op = this.getOpFromRID(op.rid) ?? op;
        return [op.fetchedCycle, this.spec.hideFlushedOps ? op.rid : op.id];
    }

    adjustScrollDifferenceXAt(
        position: readonly [number, number],
        differenceY: number,
    ): number {
        const [positionX, positionY] = position;
        const y = Math.floor(positionY);
        if (y < 0 || y > this.getVisibleBottom()) {
            return 0;
        }

        const oldOp = this.getVisibleOp(y, this.opResolution);
        const newOp = this.getVisibleOp(Math.floor(y + differenceY), this.opResolution);
        if (newOp === undefined) {
            return 0;
        }
        if (oldOp === undefined || newOp.id === oldOp.id) {
            return newOp.fetchedCycle - positionX;
        }
        return newOp.fetchedCycle - oldOp.fetchedCycle;
    }

    withPosition(position: readonly [number, number]): Readonly<KonataRenderSpec> {
        // 旧Rendererは範囲外もinvalid領域として描くため、ここではclampしない。
        return { ...this.spec, position };
    }

    withLogicalDifference(
        difference: readonly [number, number],
        adjustHorizontal: boolean,
    ): Readonly<KonataRenderSpec> {
        const oldTop = this.spec.position[1];
        const positionY = oldTop + difference[1];
        const op = this.getVisibleOp(Math.floor(positionY), this.opResolution);
        let positionX = this.spec.position[0];
        if (adjustHorizontal && op !== undefined) {
            const oldOp = this.getVisibleOp(Math.floor(oldTop), this.opResolution);
            positionX = oldOp === undefined
                ? op.fetchedCycle
                : positionX + op.fetchedCycle - oldOp.fetchedCycle;
        }
        else {
            positionX += difference[0];
        }
        return this.withPosition([positionX, positionY]);
    }

    withPixelPan(deltaX: number, deltaY: number): Readonly<KonataRenderSpec> {
        return this.withLogicalDifference([
            deltaX / this.opWidth,
            deltaY / this.opHeight,
        ], false);
    }

    withZoomLevel(
        zoomLevel: number,
        posX: number,
        posY: number,
        compensatePosition = true,
    ): Readonly<KonataRenderSpec> {
        const nextZoomLevel = clampKonataZoomLevel(zoomLevel);
        const nextSpec = { ...this.spec, zoomLevel: nextZoomLevel };
        if (!compensatePosition || nextZoomLevel === this.zoomLevel) {
            return nextSpec;
        }

        const nextMetrics = new KonataRenderMetrics(this.trace, nextSpec);
        const ratio = this.zoomScale / nextMetrics.zoomScale;
        // pointer位置にあるcycle/opを固定したまま倍率を変える。
        return {
            ...nextSpec,
            position: [
                this.spec.position[0] - (posX - posX / ratio) / nextMetrics.opWidth,
                this.spec.position[1] - (posY - posY / ratio) / nextMetrics.opHeight,
            ],
        };
    }

    getLabelToolTipText(y: number): string | null {
        const op = this.getOpFromPixelPositionY(y, this.opResolution);
        if (op === undefined) {
            return null;
        }
        let text =
            `${op.labelName}\n` +
            `${op.labelDetail}\n` +
            `Line: \t\t${op.line}\n` +
            `Serial ID:\t${op.gid}\n` +
            `Thread ID:\t\t${op.tid}\n` +
            `Retire ID:\t\t${op.rid}`;
        if (op.flush) {
            text += "\n# This op is flushed.";
        }
        return text;
    }

    getPipelineToolTipText(x: number, y: number): string | null {
        const op = this.getOpFromPixelPositionY(y, this.opResolution);
        if (op === undefined) {
            return null;
        }

        const cycle = this.getCycleFromPixelPositionX(x);
        let text = `[${cycle}, ${op.id}] `;
        if (cycle < op.fetchedCycle || cycle > op.retiredCycle) {
            return text;
        }

        let stageText = "";
        let first = true;
        for (const lane of op.lanes) {
            if (lane === null) {
                continue;
            }
            for (const stage of lane.stages) {
                const endCycle = stage.endCycle === stage.startCycle
                    ? stage.endCycle + 1
                    : stage.endCycle;
                if (stage.startCycle <= cycle && cycle < endCycle) {
                    if (!first) {
                        text += ", ";
                    }
                    text += `${stage.name}[${stage.endCycle - stage.startCycle}]`;
                    for (const line of stage.labels.split("\n")) {
                        if (line !== "") {
                            stageText += `${stage.name}: ${line}\n`;
                        }
                    }
                    first = false;
                }
            }
        }
        if (stageText !== "") {
            text += `\n${stageText}`;
        }
        return text;
    }
}

interface CanvasSize {
    width: number;
    height: number;
}

// 比較用の配色はView設定へ保存せず、比較表示の描画中だけ使う。
export const COMPARISON_COLOR_SCHEME = {
    OVERLAY_BASELINE: "__comparison_overlay_baseline",
    OVERLAY_CANDIDATE: "__comparison_overlay_candidate",
    REFERENCE: "__comparison_reference",
} as const;

type RendererStyle = typeof darkStyle;

// 旧Rendererのlabel paneと同じ表示形式を、Canvasとテストから共有する。
export function formatOpLabel(id: number, op: Op): string {
    return `${id}: s${op.gid} (t${op.tid}: r${op.rid}): ${op.labelName}`;
}

function isCustomColorDefinition(value: unknown): value is CustomColorDefinition {
    return typeof value === "object" && value !== null && "h" in value && "s" in value && "l" in value;
}

export class KonataRenderer {
    // Canvasの矩形をpixel境界へ合わせ、ぼけを抑える補正値。
    private static readonly PIXEL_ADJUST = 0.5;

    private metrics_: KonataRenderMetrics;
    private style_: RendererStyle = darkStyle;
    private renderingColorScheme_: string | null = null;
    private renderingReference_ = false;
    private labelFont_ = "";
    private labelFontSize_ = 12;
    private stageFontSize_ = 12;
    private readonly canvasBackend_ = new CanvasBackend();

    constructor() {
        this.metrics_ = new KonataRenderMetrics(null, DEFAULT_KONATA_RENDER_SPEC);
        this.updateFontValues_();
    }

    private setInput_(trace: ParsedTrace | null, spec: Readonly<KonataRenderSpec>): void {
        this.metrics_ = new KonataRenderMetrics(trace, spec);
        this.style_ = spec.theme === "light" ? lightStyle : darkStyle;
        this.updateFontValues_();
    }

    private draw_(
        labelCanvas: HTMLCanvasElement,
        pipelineCanvas: HTMLCanvasElement,
        webGLEnabled: boolean,
    ): void {
        const labelSize = this.prepareCanvas_(labelCanvas);
        const pipelineSize = this.prepareCanvas_(pipelineCanvas);
        this.drawLabel_(labelCanvas, labelSize);
        this.drawPipeline_(pipelineCanvas, pipelineSize, webGLEnabled, "all");
    }

    drawSpec(
        trace: ParsedTrace | null,
        spec: Readonly<KonataRenderSpec>,
        labelCanvas: HTMLCanvasElement,
        pipelineCanvas: HTMLCanvasElement,
        webGLEnabled = true,
    ): void {
        this.setInput_(trace, spec);
        this.draw_(labelCanvas, pipelineCanvas, webGLEnabled);
    }

    private drawLabelCanvas_(labelCanvas: HTMLCanvasElement): void {
        const labelSize = this.prepareCanvas_(labelCanvas);
        this.drawLabel_(labelCanvas, labelSize);
    }

    drawLabelSpec(
        trace: ParsedTrace | null,
        spec: Readonly<KonataRenderSpec>,
        labelCanvas: HTMLCanvasElement,
    ): void {
        this.setInput_(trace, spec);
        this.drawLabelCanvas_(labelCanvas);
    }

    private drawPipelineCanvas_(
        pipelineCanvas: HTMLCanvasElement,
        width?: number,
        height?: number,
        colorScheme?: string,
        referenceOnly = false,
        webGLEnabled = true,
        pass: KonataPipelinePass = "all",
    ): void {
        const pipelineSize = this.prepareCanvas_(pipelineCanvas, width, height);
        const previousColorScheme = this.renderingColorScheme_;
        const previousReference = this.renderingReference_;
        this.renderingColorScheme_ = colorScheme ?? null;
        this.renderingReference_ = referenceOnly;
        try {
            // 比較色と参照表示は一時的な描画条件に留め、通常のView設定を変更しない。
            this.drawPipeline_(pipelineCanvas, pipelineSize, webGLEnabled, pass);
        }
        finally {
            this.renderingColorScheme_ = previousColorScheme;
            this.renderingReference_ = previousReference;
        }
    }

    drawPipelineSpec(
        trace: ParsedTrace | null,
        spec: Readonly<KonataRenderSpec>,
        pipelineCanvas: HTMLCanvasElement,
        width?: number,
        height?: number,
        colorScheme?: string,
        referenceOnly = false,
        webGLEnabled = true,
        pass: KonataPipelinePass = "all",
    ): void {
        this.setInput_(trace, spec);
        this.drawPipelineCanvas_(
            pipelineCanvas,
            width,
            height,
            colorScheme,
            referenceOnly,
            webGLEnabled,
            pass,
        );
    }

    composePipelineLayers(
        pipelineCanvas: HTMLCanvasElement,
        baselineCanvas: HTMLCanvasElement,
        candidateCanvas: HTMLCanvasElement,
        opacity: number,
    ): void {
        const pipelineSize = this.prepareCanvas_(pipelineCanvas);
        const context = pipelineCanvas.getContext("2d");
        if (context === null) {
            return;
        }
        context.save();
        try {
            // A/Bの描画命令ごとではなく、完成済み画像全体へ一度だけopacityを適用する。
            context.clearRect(0, 0, pipelineSize.width, pipelineSize.height);
            context.globalAlpha = 1;
            context.globalCompositeOperation = "source-over";
            context.drawImage(baselineCanvas, 0, 0, pipelineSize.width, pipelineSize.height);
            context.globalAlpha = opacity;
            context.drawImage(candidateCanvas, 0, 0, pipelineSize.width, pipelineSize.height);
        }
        finally {
            context.restore();
        }
    }

    releaseCanvasResources(): void {
        this.canvasBackend_.dispose();
    }

    private updateFontValues_(): void {
        const fontSize = Number(this.style_.fontSize);
        this.labelFont_ = `${this.style_.fontStyle} ${fontSize * Math.min(1, this.metrics_.zoomScale)}px ${this.style_.fontFamily}`;
        this.labelFontSize_ = fontSize * Math.min(1, this.metrics_.zoomScale);
        this.stageFontSize_ = fontSize * this.metrics_.zoomScale;
    }

    private get canDrawDependency_(): boolean {
        return this.metrics_.canDrawDependency;
    }

    private get canDrawFrame_(): boolean {
        return this.metrics_.canDrawFrame;
    }

    private get canDrawText_(): boolean {
        return this.metrics_.canDrawText;
    }

    private prepareCanvas_(
        canvas: HTMLCanvasElement,
        requestedWidth?: number,
        requestedHeight?: number,
    ): CanvasSize {
        // DOMへ置かない比較用Canvasには、表示CanvasのCSS pixel寸法を明示する。
        const width = Math.max(1, requestedWidth ?? canvas.clientWidth);
        const height = Math.max(1, requestedHeight ?? canvas.clientHeight);
        const pixelRatio = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;
        const backingWidth = Math.max(1, Math.round(width * pixelRatio));
        const backingHeight = Math.max(1, Math.round(height * pixelRatio));
        if (canvas.width !== backingWidth || canvas.height !== backingHeight) {
            canvas.width = backingWidth;
            canvas.height = backingHeight;
        }

        const context = canvas.getContext("2d");
        if (context === null) {
            throw new Error("A 2D canvas context is required to draw a trace.");
        }
        context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
        return { width, height };
    }

    private drawLabel_(canvas: HTMLCanvasElement, size: CanvasSize): void {
        const context = canvas.getContext("2d");
        if (context === null) {
            return;
        }
        context.fillStyle = this.style_.labelPane.backgroundColor;
        context.fillRect(0, 0, size.width, size.height);
        if (this.metrics_.trace === null || !this.canDrawText_) {
            return;
        }

        context.font = this.labelFont_;
        context.fillStyle = this.style_.labelPane.fontColor;
        const logicalHeight = size.height / this.metrics_.opHeight;
        const marginLeft = Number(this.style_.labelPane.marginLeft);
        const marginTop =
            (this.metrics_.laneHeight - this.metrics_.laneHeightMargin * 2 - this.labelFontSize_) / 2 +
            this.labelFontSize_;

        for (
            let logicalY = Math.floor(this.metrics_.spec.position[1]);
            logicalY < this.metrics_.spec.position[1] + logicalHeight;
            logicalY++
        ) {
            const op = this.metrics_.getVisibleOp(logicalY);
            if (op === undefined) {
                continue;
            }
            const x = marginLeft;
            const y = (logicalY - this.metrics_.spec.position[1]) * this.metrics_.opHeight + marginTop;
            context.fillText(formatOpLabel(logicalY, op), x, y);
        }
    }

    private drawPipeline_(
        canvas: HTMLCanvasElement,
        size: CanvasSize,
        webGLEnabled: boolean,
        pass: KonataPipelinePass,
    ): void {
        const context = canvas.getContext("2d");
        if (context === null) {
            return;
        }
        const drawBase = pass !== "dependencies";
        const drawDependencies = pass !== "base";
        if (drawBase) {
            if (this.renderingReference_) {
                // 前回の参照形状を残さず、背景は透明なまま主表示へ重ねられるようにする。
                context.clearRect(0, 0, size.width, size.height);
            }
            else {
                context.fillStyle = this.style_.pipelinePane.backgroundColor;
                context.fillRect(0, 0, size.width, size.height);
            }
        }
        if (this.metrics_.trace === null) {
            return;
        }
        if (drawBase && !this.renderingReference_ && this.canDrawText_) {
            this.canvasBackend_.setTextStyle(
                context,
                this.style_.fontStyle,
                Number(this.style_.fontSize),
                this.style_.fontFamily,
                this.style_.pipelinePane.fontColor,
                this.metrics_.zoomScale,
            );
        }

        let top = this.metrics_.spec.position[1];
        const left = this.metrics_.spec.position[0];
        const logicalHeight = size.height / this.metrics_.opHeight;
        const logicalWidth = size.width / this.metrics_.opWidth;

        // 上側へはみ出した領域を旧Rendererと同じinvalid色で描く。
        let offsetY = 0;
        if (top < 0) {
            const bottom = Math.min(
                size.height,
                -top * this.metrics_.opHeight + KonataRenderer.PIXEL_ADJUST,
            );
            if (drawBase && !this.renderingReference_) {
                context.fillStyle = this.style_.pipelinePane.invalidBackgroundColor;
                context.fillRect(0, 0, size.width, bottom);
            }
            if (bottom >= size.height) {
                return;
            }
            offsetY = -top;
            top = 0;
        }

        // 矩形・文字・矢印を同じ呼出順でbackendへ積み、重なり順を維持する。
        // WebGL無効時もbackendが同じcommand列をCanvas 2Dへ再生する。
        const drawContext = this.canvasBackend_.begin(
            canvas,
            context,
            size.width,
            size.height,
            webGLEnabled,
        );
        try {
            if (drawBase) {
                let skipRendering = false;
                const step = this.metrics_.drawingStep;
                for (let y = Math.floor(top); y < top + logicalHeight; y += step) {
                    const pixelY = y - top + offsetY;
                    if (!this.renderingReference_ && this.canDrawFrame_ && y % 2 === 0) {
                        const fillTop = pixelY * this.metrics_.opHeight + KonataRenderer.PIXEL_ADJUST;
                        drawContext.fillStyle = this.style_.pipelinePane.backgroundColorStripeOverlay;
                        drawContext.fillRect(0, fillTop, size.width, this.metrics_.opHeight);
                    }
                    if (skipRendering) {
                        continue;
                    }

                    const op = this.metrics_.getVisibleOp(y, this.metrics_.opResolution);
                    if (op === undefined) {
                        // gem5ではIDが不連続でも、後続に有効な命令が存在し得る。
                        continue;
                    }
                    if (!this.drawOp_(
                        op,
                        y - top + offsetY,
                        left,
                        left + logicalWidth,
                        drawContext,
                    )) {
                        skipRendering = true;
                    }
                }
            }
            if (drawDependencies && !this.renderingReference_ &&
                this.metrics_.spec.dependencyArrowType !== DEP_ARROW_TYPE.NOT_SHOW) {
                this.drawDependency_(offsetY, top, left, logicalHeight, drawContext);
            }
        }
        finally {
            this.canvasBackend_.end();
        }

        // 最終命令より下へはみ出した領域もinvalid色で描く。dependency-onlyでは矢印が
        // invalid領域へ出ないという従来のpainter順を保つため、矢印の後にもう一度覆う。
        const bottomOuterHeight = top - offsetY + logicalHeight - 1 - this.metrics_.getVisibleBottom();
        if (!this.renderingReference_ && bottomOuterHeight > 0 &&
            (drawBase || pass === "dependencies")) {
            const begin = Math.max(
                0,
                size.height - bottomOuterHeight * this.metrics_.opHeight + KonataRenderer.PIXEL_ADJUST,
            );
            context.fillStyle = this.style_.pipelinePane.invalidBackgroundColor;
            context.fillRect(0, begin, size.width, size.height);
        }
    }

    private drawOp_(
        op: Op,
        logicalY: number,
        startCycle: number,
        endCycle: number,
        context: CanvasDrawContext,
    ): boolean {
        const top = logicalY * this.metrics_.opHeight + KonataRenderer.PIXEL_ADJUST;
        if (op.retiredCycle < startCycle) {
            return true;
        }
        if (endCycle < op.fetchedCycle) {
            return false;
        }
        if (op.retiredCycle === op.fetchedCycle) {
            return true;
        }

        let leftCycle = startCycle > op.fetchedCycle ? startCycle - 1 : op.fetchedCycle;
        let rightCycle = endCycle >= op.retiredCycle ? op.retiredCycle : endCycle + 1;
        leftCycle -= startCycle;
        rightCycle -= startCycle;
        const left = leftCycle * this.metrics_.opWidth + KonataRenderer.PIXEL_ADJUST;
        let right = rightCycle * this.metrics_.opWidth + KonataRenderer.PIXEL_ADJUST;

        const detailed = this.metrics_.canDrawDetailedly;
        if (detailed && this.canDrawFrame_) {
            context.strokeStyle = this.style_.pipelinePane.borderColor;
        }

        // 詳細時と縮小時でstage区間と色計算を共有し、出力する矩形の表現だけを替える。
        let drewStage = false;
        if (detailed) {
            const laneNum = Math.max(1, this.metrics_.trace?.stageLevelMap.laneNum ?? 1);
            for (let laneID = 0; laneID < op.lanes.length; laneID++) {
                if (op.lanes[laneID] === null) {
                    continue;
                }
                const laneTop = this.metrics_.spec.splitLanes
                    ? logicalY +
                        (this.metrics_.trace?.stageLevelMap.getLanePosition(laneID) ?? 0) / laneNum
                    : logicalY;
                drewStage = this.drawLane_(
                    op, laneTop, startCycle, endCycle, context, laneID,
                ) || drewStage;
            }
        }

        if (detailed && (this.canDrawText_ || drewStage)) {
            return true;
        }
        // 最縮小域では命令ごとの1矩形に留め、WebGLが使えない場合もCanvas負荷を抑える。
        // 詳細域でもstageを持たない命令は同じoverview表示へfallbackする。
        const colorScheme = this.activeColorScheme_;
        context.fillStyle = this.isKnownCalculatedColorScheme_()
            ? this.getComparisonOverviewColor_(colorScheme)
            : colorScheme;
        const laneTop = top + this.metrics_.laneHeightMargin;
        const laneHeight = Math.max(
            0.5,
            this.metrics_.laneHeight - this.metrics_.laneHeightMargin * 2,
        );
        right = Math.max(right, left + 1);
        context.fillRect(left, laneTop, right - left, laneHeight);
        if (!this.renderingReference_ && op.flush) {
            context.fillStyle = this.style_.pipelinePane.flushedRegionColor;
            context.fillRect(left, laneTop, right - left, laneHeight);
        }
        return true;
    }

    private drawLane_(
        op: Op,
        logicalY: number,
        startCycle: number,
        endCycle: number,
        context: CanvasDrawContext,
        laneID: number,
    ): boolean {
        const lane = op.lanes[laneID];
        if (lane === null || lane === undefined) {
            return false;
        }
        const top = logicalY * this.metrics_.opHeight + KonataRenderer.PIXEL_ADJUST;
        let drewStage = false;

        for (const stage of lane.stages) {
            const stageEndCycle = stage.endCycle === 0 ? op.retiredCycle : stage.endCycle;
            if (stageEndCycle < startCycle) {
                continue;
            }
            if (endCycle < stage.startCycle) {
                break;
            }
            if (stageEndCycle === stage.startCycle) {
                continue;
            }

            const logicalLeft = Math.max(startCycle - 1, stage.startCycle) - startCycle;
            const logicalRight = Math.min(endCycle + 1, stageEndCycle) - startCycle;
            const left = logicalLeft * this.metrics_.opWidth + KonataRenderer.PIXEL_ADJUST;
            let right = logicalRight * this.metrics_.opWidth + KonataRenderer.PIXEL_ADJUST;
            const rectTop = top + this.metrics_.laneHeightMargin;
            let rectHeight = this.metrics_.laneHeight - this.metrics_.laneHeightMargin * 2;

            // stageの開始色と終了色を渡し、最小寸法を保ってgradientを描く。
            right = Math.max(right, left + 1);
            rectHeight = Math.max(rectHeight, 0.5);
            context.fillVerticalGradientRect(
                left,
                rectTop,
                right - left,
                rectHeight,
                this.getStageColor_(laneID, stage.name, true, op),
                this.getStageColor_(laneID, stage.name, false, op),
                this.metrics_.laneHeightMargin / this.metrics_.laneHeight,
                1 - this.metrics_.laneHeightMargin / this.metrics_.laneHeight,
            );
            drewStage = true;

            if (!this.renderingReference_ && this.canDrawFrame_) {
                context.lineWidth = Number(this.style_.pipelinePane.borderWeight);
                context.strokeRect(left, rectTop, right - left, rectHeight);
            }

            if (!this.renderingReference_ && this.canDrawText_) {
                const textTop =
                    top +
                    (this.metrics_.laneHeight -
                        this.metrics_.laneHeightMargin * 2 -
                        this.stageFontSize_) / 2 +
                    this.stageFontSize_;
                const textLeft = (stage.startCycle - startCycle) * this.metrics_.opWidth;
                // stage先頭へ名前、後続cycleへ経過cycle数を表示する。
                // 左端へ一部かかる文字を残すためfloorし、画面外の1..Nをbackendへ積まない。
                const firstVisibleOffset = Math.max(
                    1,
                    Math.floor(startCycle - stage.startCycle),
                );
                for (
                    let offset = firstVisibleOffset;
                    offset < stageEndCycle - stage.startCycle &&
                        offset + stage.startCycle <= endCycle;
                    offset++
                ) {
                    const margin = Math.max(
                        0,
                        (this.metrics_.opWidth -
                            String(offset).length * this.stageFontSize_ / 2) / 2,
                    );
                    context.fillText(
                        String(offset),
                        textLeft + offset * this.metrics_.opWidth + margin,
                        textTop,
                    );
                }
                const margin = Math.max(
                    0,
                    (this.metrics_.opWidth - stage.name.length * this.stageFontSize_ / 2) / 2,
                );
                context.fillText(stage.name, textLeft + margin, textTop);
            }

            if (!this.renderingReference_ && op.flush) {
                context.fillStyle = this.style_.pipelinePane.flushedRegionColor;
                context.fillRect(left, rectTop, right - left, rectHeight);
            }
        }
        return drewStage;
    }

    private drawDependency_(
        logicalOffsetY: number,
        logicalTop: number,
        logicalLeft: number,
        logicalHeight: number,
        context: CanvasDrawContext,
    ): void {
        if (!this.canDrawDependency_) {
            return;
        }
        const arrowBeginOffsetX = this.metrics_.opWidth * 3 / 4 + KonataRenderer.PIXEL_ADJUST;
        const arrowEndOffsetX = this.metrics_.opWidth * 1 / 4 + KonataRenderer.PIXEL_ADJUST;
        const arrowMidOffsetY = this.metrics_.laneHeight / 2 + KonataRenderer.PIXEL_ADJUST;
        const arrowBeginOffsetY = this.metrics_.laneHeight * 2 / 3 + KonataRenderer.PIXEL_ADJUST;
        const arrowEndOffsetY = this.metrics_.laneHeight / 3 + KonataRenderer.PIXEL_ADJUST;
        const arrowWeight = Number(this.style_.pipelinePane.arrowWeight);
        context.lineWidth = arrowWeight;
        context.strokeStyle = this.style_.pipelinePane.arrowColor;
        context.fillStyle = this.style_.pipelinePane.arrowColor;

        for (let y = Math.floor(logicalTop); y < logicalTop + logicalHeight; y++) {
            const consumer = this.metrics_.getVisibleOp(y);
            if (consumer === undefined || consumer.consCycle === -1) {
                continue;
            }
            for (const dependency of consumer.prods) {
                const producer = this.metrics_.getOpFromID(dependency.opID);
                if (producer === undefined || producer.prodCycle === -1) {
                    continue;
                }
                if (this.metrics_.spec.hideFlushedOps && producer.flush) {
                    continue;
                }
                const producerY = this.metrics_.spec.hideFlushedOps ? producer.rid : producer.id;

                if (this.metrics_.spec.dependencyArrowType === DEP_ARROW_TYPE.INSIDE_LINE) {
                    const start: [number, number] = [
                        (producer.prodCycle - logicalLeft) * this.metrics_.opWidth + arrowBeginOffsetX,
                        (producerY - logicalTop + logicalOffsetY) * this.metrics_.opHeight +
                            arrowMidOffsetY,
                    ];
                    const end: [number, number] = [
                        (consumer.consCycle - logicalLeft) * this.metrics_.opWidth + arrowEndOffsetX,
                        (y - logicalTop + logicalOffsetY) * this.metrics_.opHeight + arrowMidOffsetY,
                    ];
                    this.drawArrow_(context, start, end, [end[0] - start[0], end[1] - start[1]], arrowWeight);
                }
                else {
                    const start: [number, number] = [
                        (producer.fetchedCycle - logicalLeft) * this.metrics_.opWidth,
                        (producerY - logicalTop + logicalOffsetY) * this.metrics_.opHeight +
                            arrowBeginOffsetY,
                    ];
                    const end: [number, number] = [
                        (consumer.fetchedCycle - logicalLeft) * this.metrics_.opWidth,
                        (y - logicalTop + logicalOffsetY) * this.metrics_.opHeight + arrowEndOffsetY,
                    ];
                    this.drawArrow_(context, start, end, [1, 0], arrowWeight);
                }
            }
        }
    }

    private drawArrow_(
        context: CanvasDrawContext,
        start: readonly [number, number],
        end: readonly [number, number],
        vector: readonly [number, number],
        size: number,
    ): void {
        context.beginPath();
        context.moveTo(start[0], start[1]);
        if (this.metrics_.spec.dependencyArrowType === DEP_ARROW_TYPE.INSIDE_LINE) {
            context.lineTo(end[0], end[1]);
        }
        else {
            const offsetX = start[0] - this.metrics_.opWidth *
                Math.sqrt((end[1] - start[1]) / this.metrics_.opHeight);
            context.bezierCurveTo(offsetX, start[1], offsetX, end[1], end[0], end[1]);
        }
        context.stroke();

        const norm = Math.hypot(vector[0], vector[1]);
        if (norm === 0) {
            return;
        }
        const factor = size * 5 / norm;
        const x = vector[0] * factor;
        const y = vector[1] * factor;
        const shape = 0.8;
        context.beginPath();
        context.moveTo(end[0], end[1]);
        context.lineTo(end[0] - x - y * 0.5 * shape, end[1] - y + x * 0.5 * shape);
        context.lineTo(end[0] - x + y * 0.5 * shape, end[1] - y - x * 0.5 * shape);
        context.fill();
    }

    private getStageColor_(laneID: number, stageName: string, isBegin: boolean, op: Op): string {
        const laneName = this.metrics_.trace?.stageLevelMap.getLaneName(laneID) ?? String(laneID);
        const colorScheme = this.activeColorScheme_;
        if (this.isComparisonColorScheme_(colorScheme)) {
            return this.getComparisonStageColor_(colorScheme, laneName, stageName, isBegin);
        }
        if (colorScheme === "Auto" || colorScheme === "Unique") {
            if (stageName === "f" || stageName === "stl") {
                return this.style_.pipelinePane.stallBackgroundColor;
            }
            const stageLevel = this.metrics_.trace?.stageLevelMap.get(laneName, stageName);
            const lanePosition = this.metrics_.trace?.stageLevelMap.getLanePosition(laneID) ?? 0;
            const level = colorScheme === "Auto"
                ? stageLevel?.appearance ?? 0
                : stageLevel?.unique ?? 0;
            const color = this.style_.pipelinePane.stageBackgroundColor;
            const rate = Number(isBegin ? color.hRateBegin : color.hRateEnd);
            const saturation = Number(isBegin ? color.sBegin : color.sEnd);
            const lightness = Number(isBegin ? color.lBegin : color.lEnd);
            const hue = (250 - level * rate + lanePosition * 28 * 8 + 3600) % 360;
            return `hsl(${hue},${saturation}%,${lightness}%)`;
        }

        if (colorScheme === "ThreadID") {
            const stageLevel = this.metrics_.trace?.stageLevelMap.get(laneName, stageName);
            const color = this.style_.pipelinePane.stageBackgroundColor;
            const hueRate = Number(isBegin ? color.hRateBegin : color.hRateEnd);
            const saturation = Number(isBegin ? color.sBegin : color.sEnd);
            const baseLightness = Number(isBegin ? color.lBegin : color.lEnd);
            const hue = (250 - op.tid * hueRate + 3600) % 360;
            const direction = baseLightness > 50 ? -1 : 1;
            const lightness =
                (1000 + baseLightness + direction * (stageLevel?.appearance ?? 0) * 4) % 100;
            return `hsl(${hue},${saturation}%,${lightness}%)`;
        }

        const customScheme = colorScheme === "Custom"
            ? this.metrics_.spec.customColorScheme
            : undefined;
        if (customScheme !== undefined) {
            let color = customScheme.defaultColor;
            const lane = customScheme[laneName];
            if (!isCustomColorDefinition(lane)) {
                color = lane?.[stageName] ?? color;
            }
            const base = this.style_.pipelinePane.stageBackgroundColor;
            const saturation = this.colorComponent_(color.s, isBegin ? base.sBegin : base.sEnd);
            const lightness = this.colorComponent_(color.l, isBegin ? base.lBegin : base.lEnd);
            return `hsl(${color.h},${saturation},${lightness})`;
        }
        return colorScheme;
    }

    private get activeColorScheme_(): string {
        return this.renderingColorScheme_ ?? this.metrics_.spec.colorScheme;
    }

    private isComparisonColorScheme_(colorScheme: string): boolean {
        return colorScheme === COMPARISON_COLOR_SCHEME.OVERLAY_BASELINE ||
            colorScheme === COMPARISON_COLOR_SCHEME.OVERLAY_CANDIDATE ||
            colorScheme === COMPARISON_COLOR_SCHEME.REFERENCE;
    }

    private getComparisonOverviewColor_(colorScheme: string): string {
        if (colorScheme === COMPARISON_COLOR_SCHEME.OVERLAY_BASELINE) {
            return this.metrics_.spec.theme === "dark" ? "rgb(45,105,195)" : "rgb(100,155,225)";
        }
        if (colorScheme === COMPARISON_COLOR_SCHEME.OVERLAY_CANDIDATE) {
            return this.metrics_.spec.theme === "dark" ? "rgb(225,165,75)" : "rgb(230,175,105)";
        }
        if (colorScheme === COMPARISON_COLOR_SCHEME.REFERENCE) {
            return this.metrics_.spec.theme === "dark" ? "rgb(210,210,210)" : "rgb(70,70,70)";
        }
        return "#888888";
    }

    private getComparisonStageColor_(
        colorScheme: string,
        laneName: string,
        stageName: string,
        isBegin: boolean,
    ): string {
        if (colorScheme === COMPARISON_COLOR_SCHEME.REFERENCE) {
            return this.metrics_.spec.theme === "dark" ? "rgb(210,210,210)" : "rgb(70,70,70)";
        }

        // stage名から両traceで同じ特徴量を作り、Aには加算、Bには減算する。
        // 同じstage同士はopacity 0.5で必ず無彩色になり、違うstageだけに色差が残る。
        let hash = 2166136261;
        for (const character of `${laneName}\0${stageName}`) {
            hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
        }
        // 短いstage名の末尾だけが違う場合も、RGB全成分へ差が広がるよう最終mixを行う。
        hash ^= hash >>> 16;
        hash = Math.imul(hash, 0x85ebca6b);
        hash ^= hash >>> 13;
        hash = Math.imul(hash, 0xc2b2ae35);
        const unsignedHash = (hash ^ (hash >>> 16)) >>> 0;
        const lightTheme = this.metrics_.spec.theme === "light";
        const neutral = lightTheme
            ? (isBegin ? 175 : 155)
            : (isBegin ? 140 : 130);
        const baselineRed = lightTheme
            ? (isBegin ? 137 : 97)
            : (isBegin ? 67 : 50);
        const baselineGreen = lightTheme
            ? (isBegin ? 165 : 140)
            : (isBegin ? 120 : 95);
        const baselineBlue = lightTheme
            ? (isBegin ? 213 : 213)
            : (isBegin ? 210 : 180);
        // 各成分を4段階に離し、異なるsignatureの局所色を灰色から強く浮かせる。
        const redOffset = (unsignedHash & 0x3) * 28 - 42;
        const greenOffset = ((unsignedHash >>> 2) & 0x3) * 28 - 42;
        const blueOffset = ((unsignedHash >>> 4) & 0x3) * 28 - 42;
        const baseline = colorScheme === COMPARISON_COLOR_SCHEME.OVERLAY_BASELINE;
        const direction = baseline ? 1 : -1;
        const red = (baseline ? baselineRed : neutral * 2 - baselineRed) + direction * redOffset;
        const green = (baseline ? baselineGreen : neutral * 2 - baselineGreen) + direction * greenOffset;
        const blue = (baseline ? baselineBlue : neutral * 2 - baselineBlue) + direction * blueOffset;
        return `rgb(${red},${green},${blue})`;
    }

    private colorComponent_(value: CustomColorComponent, automatic: string): string {
        const component = value === "auto" ? automatic : value;
        return `${component}%`;
    }

    private isKnownCalculatedColorScheme_(): boolean {
        const colorScheme = this.activeColorScheme_;
        return colorScheme === "Auto" ||
            colorScheme === "Unique" ||
            colorScheme === "ThreadID" ||
            this.isComparisonColorScheme_(colorScheme) ||
            colorScheme === "Custom";
    }
}
