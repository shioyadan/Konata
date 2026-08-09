import type { Op, ParsedTrace } from "../core/model";

// fsで読むと配布後のcurrent directoryに依存するため、旧Rendererと同じく
// style定義はmoduleとしてbundleへ取り込む。
import darkStyle from "../../theme/dark/style.json";
import lightStyle from "../../theme/light/style.json";

interface CanvasSize {
    width: number;
    height: number;
}

interface ViewPosition {
    left: number;
    top: number;
}

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

type RendererStyle = typeof darkStyle;

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

const DEFAULT_CUSTOM_COLOR_SCHEMES: Readonly<Record<string, CustomColorScheme>> = {
    Custom: DEFAULT_CUSTOM_COLOR_SCHEME,
};

// 旧Rendererのlabel paneと同じ表示形式を、Canvasとテストから共有する。
export function formatOpLabel(id: number, op: Op): string {
    return `${id}: s${op.gid} (t${op.tid}: r${op.rid}): ${op.labelName}`;
}

function isCustomColorDefinition(value: unknown): value is CustomColorDefinition {
    return typeof value === "object" && value !== null && "h" in value && "s" in value && "l" in value;
}

export class KonataRenderer {
    static readonly OP_W = 32;
    static readonly OP_H = 24;

    readonly name = "KonataRenderer";
    // 描画モードを切り替える閾値は旧Configの既定値をそのまま使う。
    drawDetailedlyThreshold = 1;
    drawDependencyThreshold = 4;
    drawFrameThreshold = 4;
    drawTextThreshold = 10;

    private static readonly ZOOM_RATIO = 1;
    private static readonly MAX_ZOOM_LEVEL = 24;
    private static readonly LANE_HEIGHT_MARGIN = 2;
    // Canvasの矩形をpixel境界へ合わせ、ぼけを抑える補正値。
    private static readonly PIXEL_ADJUST = 0.5;

    // 論理位置の単位は、横がcycle、縦が命令である。
    private viewPosition_: ViewPosition = { left: 0, top: 0 };
    private trace_: ParsedTrace | null = null;
    private style_: RendererStyle = darkStyle;
    private theme_: RendererTheme = "dark";
    private colorScheme_ = "Auto";
    private customColorSchemes_: Readonly<Record<string, CustomColorScheme>> = DEFAULT_CUSTOM_COLOR_SCHEMES;
    private dependencyArrowType_: DependencyArrowType = DEP_ARROW_TYPE.INSIDE_LINE;
    private splitLanes_ = false;
    private fixOpHeight_ = false;
    private hideFlushedOps_ = false;

    // 拡大率は旧Rendererと同じzoom levelの指数で管理する。
    private zoomLevel_ = 0;
    private zoomScale_ = 1;
    private laneNum_ = 1;
    private laneWidth_ = KonataRenderer.OP_W;
    private laneHeight_ = KonataRenderer.OP_H;
    private opWidth_ = KonataRenderer.OP_W;
    private opHeight_ = KonataRenderer.OP_H;
    private laneHeightMargin_ = KonataRenderer.LANE_HEIGHT_MARGIN;
    private drawingInterval_ = 1;
    private labelFont_ = "";
    private stageFont_ = "";
    private labelFontSize_ = 12;
    private stageFontSize_ = 12;

    constructor() {
        this.updateScaleParameter_();
    }

    setTrace(trace: ParsedTrace | null): void {
        // 非表示tabを再表示するだけなら、tab固有の座標と倍率を維持する。
        if (this.trace_ === trace) {
            return;
        }
        this.trace_ = trace;
        this.resetView();
    }

    resetView(): void {
        this.viewPosition_ = { left: 0, top: 0 };
        this.zoomLevel_ = 0;
        this.zoomScale_ = this.calcScale_(this.zoomLevel_);
        this.updateScaleParameter_();
    }

    get opWidth(): number {
        return this.opWidth_;
    }

    get opHeight(): number {
        return this.opHeight_;
    }

    get viewPosition(): readonly [number, number] {
        return [this.viewPosition_.left, this.viewPosition_.top];
    }

    get zoomLevel(): number {
        return this.zoomLevel_;
    }

    get zoomScale(): number {
        return this.zoomScale_;
    }

    get zoomPercent(): number {
        return this.zoomScale_ * 100;
    }

    get zoomPercentLabel(): string {
        const percent = this.zoomPercent;
        // 大幅に縮小しても0%に丸めず、ツールバー内に収まる桁数で倍率を示す。
        const value = percent >= 0.01
            ? Number(percent.toPrecision(3)).toString()
            : percent.toExponential(1);
        return `${value}%`;
    }

    // 縦方向は24px/opなので、2^5より小さくなった時だけ取得解像度を落とす。
    get opResolution(): number {
        return this.zoomLevel_ - 5;
    }

    get splitLanes(): boolean {
        return this.splitLanes_;
    }

    set splitLanes(value: boolean) {
        this.splitLanes_ = value;
        this.updateScaleParameter_();
    }

    get fixOpHeight(): boolean {
        return this.fixOpHeight_;
    }

    set fixOpHeight(value: boolean) {
        this.fixOpHeight_ = value;
        this.updateScaleParameter_();
    }

    get hideFlushedOps(): boolean {
        return this.hideFlushedOps_;
    }

    set hideFlushedOps(value: boolean) {
        this.hideFlushedOps_ = value;
        this.updateScaleParameter_();
    }

    get dependencyArrowType(): DependencyArrowType {
        return this.dependencyArrowType_;
    }

    set dependencyArrowType(value: DependencyArrowType) {
        this.dependencyArrowType_ = value;
    }

    setTheme(theme: RendererTheme): void {
        this.theme_ = theme;
        this.style_ = theme === "light" ? lightStyle : darkStyle;
        this.updateScaleParameter_();
    }

    get theme(): RendererTheme {
        return this.theme_;
    }

    changeColorScheme(scheme: string): void {
        this.colorScheme_ = scheme;
    }

    get colorScheme(): string {
        return this.colorScheme_;
    }

    setCustomColorSchemes(schemes: Readonly<Record<string, CustomColorScheme>>): void {
        this.customColorSchemes_ = schemes;
    }

    get customColorScheme(): Readonly<CustomColorScheme> {
        return this.customColorSchemes_.Custom ?? DEFAULT_CUSTOM_COLOR_SCHEME;
    }

    // 現在のReact UIの倍率指定を、旧Rendererの1段階zoomへ対応させる。
    zoomAt(factor: number, posX: number, posY: number): void {
        if (factor === 1) {
            return;
        }
        this.zoom(factor > 1 ? -1 : 1, posX, posY);
    }

    zoom(zoomLevelDifference: number, posX: number, posY: number): void {
        this.zoomAbs(this.zoomLevel_ + zoomLevelDifference, posX, posY);
    }

    clampZoomLevel(zoomLevel: number): number {
        return Math.max(-1, Math.min(KonataRenderer.MAX_ZOOM_LEVEL, zoomLevel));
    }

    zoomAbs(zoomLevel: number, posX: number, posY: number, compensatePosition = true): void {
        this.zoomLevel_ = this.clampZoomLevel(zoomLevel);
        const oldScale = this.zoomScale_;
        this.zoomScale_ = this.calcScale_(this.zoomLevel_);
        this.updateScaleParameter_();

        // pointer位置にあるcycle/opを固定したまま倍率を変える。
        if (compensatePosition) {
            const ratio = oldScale / this.zoomScale_;
            this.moveLogicalPosition([
                this.viewPosition_.left - (posX - posX / ratio) / this.opWidth_,
                this.viewPosition_.top - (posY - posY / ratio) / this.opHeight_,
            ]);
        }
    }

    // pixel数を論理cycle/opへ変換して表示位置を移動する。
    panPixels(deltaX: number, deltaY: number): void {
        this.moveLogicalDifference([
            deltaX / this.opWidth_,
            deltaY / this.opHeight_,
        ], false);
    }

    moveWheel(wheelUp: boolean): void {
        const scroll = 3 / this.zoomScale_;
        this.moveLogicalDifference([0, wheelUp ? scroll : -scroll], true);
    }

    adjustScrollDifferenceX(differenceY: number): number {
        return this.adjustScrollDifferenceXAt(this.viewPosition, differenceY);
    }

    // wheelの未到達目標へ次の入力を足す場合も、旧版と同じ命令追従量を計算する。
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

    moveLogicalDifference(difference: readonly [number, number], adjust: boolean): void {
        const positionY = this.viewPosition_.top + difference[1];
        const op = this.getVisibleOp(Math.floor(positionY), this.opResolution);
        const oldTop = this.viewPosition_.top;
        this.viewPosition_.top = positionY;

        if (adjust && op !== undefined) {
            const oldOp = this.getVisibleOp(Math.floor(oldTop), this.opResolution);
            if (oldOp === undefined) {
                this.viewPosition_.left = op.fetchedCycle;
            }
            else {
                this.viewPosition_.left += op.fetchedCycle - oldOp.fetchedCycle;
            }
        }
        else {
            this.viewPosition_.left += difference[0];
        }
    }

    moveLogicalPosition(position: readonly [number, number]): void {
        // 旧Rendererは範囲外もinvalid領域として描くため、ここではclampしない。
        this.viewPosition_.left = position[0];
        this.viewPosition_.top = position[1];
    }

    getAdjustedViewPosition(): readonly [number, number] | null {
        if (this.trace_ === null) {
            return null;
        }

        const top = this.viewPosition_.top;
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

        // flushされた命令よりRIDに対応するretire済み命令を優先し、将来のTab同期でも同じ基準を使う。
        op = this.getOpFromRID(op.rid) ?? op;
        return [op.fetchedCycle, this.hideFlushedOps_ ? op.rid : op.id];
    }

    getVisibleOp(y: number, resolution = 0): Op | undefined {
        return this.hideFlushedOps_
            ? this.getOpFromRID(y, resolution)
            : this.getOpFromID(y, resolution);
    }

    getVisibleBottom(): number {
        if (this.trace_ === null) {
            return 0;
        }
        return this.hideFlushedOps_ ? this.trace_.lastRID : this.trace_.lastID;
    }

    getPositionYFromRID(rid: number): number {
        if (this.hideFlushedOps_) {
            return rid;
        }
        return this.getOpFromRID(rid)?.id ?? -1;
    }

    getPositionYFromOp(baseOp: Op): number {
        if (!this.hideFlushedOps_) {
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
        return this.trace_?.getOp(id, resolution);
    }

    getOpFromRID(rid: number, resolution = 0): Op | undefined {
        return this.trace_?.getOpFromRID(rid, resolution);
    }

    getOpFromPixelPositionY(y: number, resolution = 0): Op | undefined {
        const logicalY = Math.floor(this.viewPosition_.top + y / this.opHeight_);
        return this.getVisibleOp(logicalY, resolution);
    }

    getPixelPositionYFromOp(op: Op): number {
        const y = this.hideFlushedOps_ ? op.rid : op.id;
        return (y - this.viewPosition_.top) * this.opHeight_;
    }

    getCycleFromPixelPositionX(x: number): number {
        return Math.floor(this.viewPosition_.left + x / this.opWidth_);
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

        // 同じcycleに複数laneが重なっている場合は、stage名をカンマ区切りで並べる。
        let stageText = "";
        let first = true;
        for (const lane of op.lanes.values()) {
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

    draw(labelCanvas: HTMLCanvasElement, pipelineCanvas: HTMLCanvasElement): void {
        const labelSize = this.prepareCanvas_(labelCanvas);
        const pipelineSize = this.prepareCanvas_(pipelineCanvas);
        // 非同期読み込み中はlane数が変わり得るため、旧Rendererと同じく描画直前に更新する。
        this.updateScaleParameter_();
        this.drawLabel_(labelCanvas, labelSize);
        this.drawPipeline_(pipelineCanvas, pipelineSize);
    }

    private calcScale_(level: number): number {
        return 2 ** (-level * KonataRenderer.ZOOM_RATIO);
    }

    private updateScaleParameter_(): void {
        this.laneNum_ = this.trace_?.stageLevelMap.laneNum ?? 1;
        let laneNum = this.laneNum_;
        this.laneWidth_ = KonataRenderer.OP_W * this.zoomScale_;
        this.opWidth_ = this.laneWidth_;

        if (!this.splitLanes_ || laneNum === 0) {
            // lane mapが空の時にopHeightが0となり、描画loopが止まらなくなることを避ける。
            laneNum = 1;
        }
        if (this.fixOpHeight_) {
            this.laneHeight_ = KonataRenderer.OP_H * this.zoomScale_ / laneNum;
            this.opHeight_ = this.laneHeight_ * laneNum;
        }
        else {
            this.laneHeight_ = KonataRenderer.OP_H * this.zoomScale_;
            this.opHeight_ = this.laneHeight_ * laneNum;
        }

        this.laneHeightMargin_ = this.canDrawFrame_
            ? KonataRenderer.LANE_HEIGHT_MARGIN * this.zoomScale_
            : 0;
        this.drawingInterval_ = Math.floor(1 / KonataRenderer.OP_H / this.zoomScale_ / 2);

        const fontSize = Number(this.style_.fontSize);
        this.labelFont_ = `${this.style_.fontStyle} ${fontSize * Math.min(1, this.zoomScale_)}px ${this.style_.fontFamily}`;
        this.stageFont_ = `${this.style_.fontStyle} ${fontSize * this.zoomScale_}px ${this.style_.fontFamily}`;
        this.labelFontSize_ = fontSize * Math.min(1, this.zoomScale_);
        this.stageFontSize_ = fontSize * this.zoomScale_;
    }

    private get canDrawDetailedly_(): boolean {
        return this.laneHeight_ - this.laneHeightMargin_ * 2 > this.drawDetailedlyThreshold;
    }

    private get canDrawDependency_(): boolean {
        return this.laneHeight_ - this.laneHeightMargin_ * 2 > this.drawDependencyThreshold;
    }

    private get canDrawFrame_(): boolean {
        return this.laneHeight_ - this.laneHeightMargin_ * 2 > this.drawFrameThreshold;
    }

    private get canDrawText_(): boolean {
        return this.laneHeight_ - this.laneHeightMargin_ * 2 > this.drawTextThreshold;
    }

    private prepareCanvas_(canvas: HTMLCanvasElement): CanvasSize {
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
        if (this.trace_ === null || !this.canDrawText_) {
            return;
        }

        context.font = this.labelFont_;
        context.fillStyle = this.style_.labelPane.fontColor;
        const logicalHeight = size.height / this.opHeight_;
        const marginLeft = Number(this.style_.labelPane.marginLeft);
        const marginTop =
            (this.laneHeight_ - this.laneHeightMargin_ * 2 - this.labelFontSize_) / 2 +
            this.labelFontSize_;

        for (
            let logicalY = Math.floor(this.viewPosition_.top);
            logicalY < this.viewPosition_.top + logicalHeight;
            logicalY++
        ) {
            const op = this.getVisibleOp(logicalY);
            if (op === undefined) {
                continue;
            }
            const x = marginLeft;
            const y = (logicalY - this.viewPosition_.top) * this.opHeight_ + marginTop;
            context.fillText(formatOpLabel(logicalY, op), x, y);
        }
    }

    private drawPipeline_(canvas: HTMLCanvasElement, size: CanvasSize): void {
        const context = canvas.getContext("2d");
        if (context === null) {
            return;
        }
        context.fillStyle = this.style_.pipelinePane.backgroundColor;
        context.fillRect(0, 0, size.width, size.height);
        if (this.trace_ === null) {
            return;
        }

        let top = this.viewPosition_.top;
        const left = this.viewPosition_.left;
        const logicalHeight = size.height / this.opHeight_;
        const logicalWidth = size.width / this.opWidth_;

        // 上側へはみ出した領域を旧Rendererと同じinvalid色で描く。
        let offsetY = 0;
        if (top < 0) {
            const bottom = Math.min(size.height, -top * this.opHeight_ + KonataRenderer.PIXEL_ADJUST);
            context.fillStyle = this.style_.pipelinePane.invalidBackgroundColor;
            context.fillRect(0, 0, size.width, bottom);
            if (bottom >= size.height) {
                return;
            }
            offsetY = -top;
            top = 0;
        }

        let skipRendering = false;
        const step = this.opHeight_ < 0.25 ? Math.max(1, this.drawingInterval_) : 1;
        for (let y = Math.floor(top); y < top + logicalHeight; y += step) {
            const pixelY = y - top + offsetY;
            if (this.canDrawFrame_ && y % 2 === 0) {
                const fillTop = pixelY * this.opHeight_ + KonataRenderer.PIXEL_ADJUST;
                context.fillStyle = this.style_.pipelinePane.backgroundColorStripeOverlay;
                context.fillRect(0, fillTop, size.width, this.opHeight_);
            }
            if (skipRendering) {
                continue;
            }

            const op = this.getVisibleOp(y, this.opResolution);
            if (op === undefined) {
                // gem5ではIDが不連続でも、後続に有効な命令が存在し得る。
                continue;
            }
            if (!this.drawOp_(op, y - top + offsetY, left, left + logicalWidth, context)) {
                skipRendering = true;
            }
        }

        if (this.dependencyArrowType_ !== DEP_ARROW_TYPE.NOT_SHOW) {
            this.drawDependency_(offsetY, top, left, logicalHeight, context);
        }

        // 最終命令より下へはみ出した領域もinvalid色で描く。
        const bottomOuterHeight = top - offsetY + logicalHeight - 1 - this.getVisibleBottom();
        if (bottomOuterHeight > 0) {
            const begin = Math.max(
                0,
                size.height - bottomOuterHeight * this.opHeight_ + KonataRenderer.PIXEL_ADJUST,
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
        context: CanvasRenderingContext2D,
    ): boolean {
        const top = logicalY * this.opHeight_ + KonataRenderer.PIXEL_ADJUST;
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
        const left = leftCycle * this.opWidth_ + KonataRenderer.PIXEL_ADJUST;
        let right = rightCycle * this.opWidth_ + KonataRenderer.PIXEL_ADJUST;

        if (this.canDrawDetailedly_) {
            context.strokeStyle = this.style_.pipelinePane.borderColor;
            const laneNum = Math.max(1, this.trace_?.stageLevelMap.laneNum ?? 1);
            for (const [laneName] of op.lanes) {
                const laneTop = this.splitLanes_
                    ? logicalY + (this.trace_?.stageLevelMap.getLaneID(laneName) ?? 0) / laneNum
                    : logicalY;
                this.drawLane_(op, laneTop, startCycle, endCycle, context, laneName);
            }
        }
        else {
            // 十分小さい時はstageを分けず、命令全体を単色で簡略表示する。
            context.fillStyle = this.isKnownCalculatedColorScheme_() ? "#888888" : this.colorScheme_;
            const laneTop = top + this.laneHeightMargin_;
            const laneHeight = Math.max(0.5, this.laneHeight_ - this.laneHeightMargin_ * 2);
            if (right - left < 1) {
                right = left + 1;
            }
            context.fillRect(left, laneTop, right - left, laneHeight);
            if (op.flush) {
                context.fillStyle = this.style_.pipelinePane.flushedRegionColor;
                context.fillRect(left, laneTop, right - left, laneHeight);
            }
        }
        return true;
    }

    private drawLane_(
        op: Op,
        logicalY: number,
        startCycle: number,
        endCycle: number,
        context: CanvasRenderingContext2D,
        laneName: string,
    ): void {
        const lane = op.lanes.get(laneName);
        if (lane === undefined) {
            return;
        }
        context.font = this.stageFont_;
        const top = logicalY * this.opHeight_ + KonataRenderer.PIXEL_ADJUST;

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
            const left = logicalLeft * this.opWidth_ + KonataRenderer.PIXEL_ADJUST;
            const right = logicalRight * this.opWidth_ + KonataRenderer.PIXEL_ADJUST;
            const rectTop = top + this.laneHeightMargin_;
            const rectHeight = this.laneHeight_ - this.laneHeightMargin_ * 2;

            // 旧Rendererはstageの開始色と終了色を上下方向のgradientとして描く。
            const gradient = context.createLinearGradient(0, top, 0, top + this.laneHeight_);
            gradient.addColorStop(0, this.getStageColor_(laneName, stage.name, true, op));
            gradient.addColorStop(1, this.getStageColor_(laneName, stage.name, false, op));
            context.fillStyle = gradient;
            context.fillRect(left, rectTop, right - left, rectHeight);

            if (this.canDrawFrame_) {
                context.lineWidth = Number(this.style_.pipelinePane.borderWeight);
                context.strokeRect(left, rectTop, right - left, rectHeight);
            }

            if (this.canDrawText_) {
                context.fillStyle = this.style_.pipelinePane.fontColor;
                const textTop =
                    top +
                    (this.laneHeight_ - this.laneHeightMargin_ * 2 - this.stageFontSize_) / 2 +
                    this.stageFontSize_;
                const textLeft = (stage.startCycle - startCycle) * this.opWidth_;
                // stage先頭へ名前、後続cycleへ経過cycle数を表示する。
                for (let offset = 1; offset < stageEndCycle - stage.startCycle; offset++) {
                    if (offset + stage.startCycle > endCycle) {
                        // 異常に長いstageでも画面外のfillTextを繰り返さない。
                        break;
                    }
                    const margin = Math.max(
                        0,
                        (this.opWidth_ - String(offset).length * this.stageFontSize_ / 2) / 2,
                    );
                    context.fillText(String(offset), textLeft + offset * this.opWidth_ + margin, textTop);
                }
                const margin = Math.max(
                    0,
                    (this.opWidth_ - stage.name.length * this.stageFontSize_ / 2) / 2,
                );
                context.fillText(stage.name, textLeft + margin, textTop);
            }

            if (op.flush) {
                context.fillStyle = this.style_.pipelinePane.flushedRegionColor;
                context.fillRect(left, rectTop, right - left, rectHeight);
            }
        }
    }

    private drawDependency_(
        logicalOffsetY: number,
        logicalTop: number,
        logicalLeft: number,
        logicalHeight: number,
        context: CanvasRenderingContext2D,
    ): void {
        if (!this.canDrawDependency_) {
            return;
        }
        const arrowBeginOffsetX = this.opWidth_ * 3 / 4 + KonataRenderer.PIXEL_ADJUST;
        const arrowEndOffsetX = this.opWidth_ * 1 / 4 + KonataRenderer.PIXEL_ADJUST;
        const arrowMidOffsetY = this.laneHeight_ / 2 + KonataRenderer.PIXEL_ADJUST;
        const arrowBeginOffsetY = this.laneHeight_ * 2 / 3 + KonataRenderer.PIXEL_ADJUST;
        const arrowEndOffsetY = this.laneHeight_ / 3 + KonataRenderer.PIXEL_ADJUST;
        const arrowWeight = Number(this.style_.pipelinePane.arrowWeight);
        context.lineWidth = arrowWeight;
        context.strokeStyle = this.style_.pipelinePane.arrowColor;
        context.fillStyle = this.style_.pipelinePane.arrowColor;

        for (let y = Math.floor(logicalTop); y < logicalTop + logicalHeight; y++) {
            const consumer = this.getVisibleOp(y);
            if (consumer === undefined || consumer.consCycle === -1) {
                continue;
            }
            for (const dependency of consumer.prods) {
                const producer = this.getOpFromID(dependency.opID);
                if (producer === undefined || producer.prodCycle === -1) {
                    continue;
                }
                if (this.hideFlushedOps_ && producer.flush) {
                    continue;
                }
                const producerY = this.hideFlushedOps_ ? producer.rid : producer.id;

                if (this.dependencyArrowType_ === DEP_ARROW_TYPE.INSIDE_LINE) {
                    const start: [number, number] = [
                        (producer.prodCycle - logicalLeft) * this.opWidth_ + arrowBeginOffsetX,
                        (producerY - logicalTop + logicalOffsetY) * this.opHeight_ + arrowMidOffsetY,
                    ];
                    const end: [number, number] = [
                        (consumer.consCycle - logicalLeft) * this.opWidth_ + arrowEndOffsetX,
                        (y - logicalTop + logicalOffsetY) * this.opHeight_ + arrowMidOffsetY,
                    ];
                    this.drawArrow_(context, start, end, [end[0] - start[0], end[1] - start[1]], arrowWeight);
                }
                else {
                    const start: [number, number] = [
                        (producer.fetchedCycle - logicalLeft) * this.opWidth_,
                        (producerY - logicalTop + logicalOffsetY) * this.opHeight_ + arrowBeginOffsetY,
                    ];
                    const end: [number, number] = [
                        (consumer.fetchedCycle - logicalLeft) * this.opWidth_,
                        (y - logicalTop + logicalOffsetY) * this.opHeight_ + arrowEndOffsetY,
                    ];
                    this.drawArrow_(context, start, end, [1, 0], arrowWeight);
                }
            }
        }
    }

    private drawArrow_(
        context: CanvasRenderingContext2D,
        start: readonly [number, number],
        end: readonly [number, number],
        vector: readonly [number, number],
        size: number,
    ): void {
        context.beginPath();
        context.moveTo(start[0], start[1]);
        if (this.dependencyArrowType_ === DEP_ARROW_TYPE.INSIDE_LINE) {
            context.lineTo(end[0], end[1]);
        }
        else {
            const offsetX = start[0] - this.opWidth_ * Math.sqrt((end[1] - start[1]) / this.opHeight_);
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

    private getStageColor_(laneName: string, stageName: string, isBegin: boolean, op: Op): string {
        if (this.colorScheme_ === "Auto" || this.colorScheme_ === "Unique") {
            if (stageName === "f" || stageName === "stl") {
                return this.style_.pipelinePane.stallBackgroundColor;
            }
            const stageLevel = this.trace_?.stageLevelMap.get(laneName, stageName);
            const laneID = this.trace_?.stageLevelMap.getLaneID(laneName) ?? 0;
            const level = this.colorScheme_ === "Auto"
                ? stageLevel?.appearance ?? 0
                : stageLevel?.unique ?? 0;
            const color = this.style_.pipelinePane.stageBackgroundColor;
            const rate = Number(isBegin ? color.hRateBegin : color.hRateEnd);
            const saturation = Number(isBegin ? color.sBegin : color.sEnd);
            const lightness = Number(isBegin ? color.lBegin : color.lEnd);
            const hue = (250 - level * rate + laneID * 28 * 8 + 3600) % 360;
            return `hsl(${hue},${saturation}%,${lightness}%)`;
        }

        if (this.colorScheme_ === "ThreadID") {
            const stageLevel = this.trace_?.stageLevelMap.get(laneName, stageName);
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

        const customScheme = this.customColorSchemes_[this.colorScheme_];
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
        return this.colorScheme_;
    }

    private colorComponent_(value: CustomColorComponent, automatic: string): string {
        const component = value === "auto" ? automatic : value;
        return `${component}%`;
    }

    private isKnownCalculatedColorScheme_(): boolean {
        return this.colorScheme_ === "Auto" ||
            this.colorScheme_ === "Unique" ||
            this.colorScheme_ === "ThreadID" ||
            this.customColorSchemes_[this.colorScheme_] !== undefined;
    }
}
