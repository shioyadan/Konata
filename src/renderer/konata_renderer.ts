import type { Op, ParsedTrace, Stage } from "../core/model";

// fsで読むと配布後のcurrent directoryに依存するため、旧Rendererと同じく
// style定義はmoduleとしてbundleへ取り込む。
import darkStyle from "../../theme/dark/style.json";

interface CanvasSize {
    width: number;
    height: number;
}

export interface StageRect {
    left: number;
    top: number;
    width: number;
    height: number;
}

// 旧Rendererのlabel paneで使っていた表示形式を、Canvasとテストから共有する。
export function formatOpLabel(id: number, op: Op): string {
    return `${id}: s${op.gid} (t${op.tid}: r${op.rid}): ${op.labelName}`;
}

// stage位置の互換性をpixel単位で固定できるよう、座標変換を描画処理から分離する。
export function calculateStageRect(
    op: Op,
    stage: Stage,
    leftCycle: number,
    topOp: number,
    scale: number,
): StageRect {
    const cycleWidth = KonataRenderer.OP_W * scale;
    const rowHeight = KonataRenderer.OP_H * scale;
    const endCycle = stage.endCycle === 0 ? op.retiredCycle : stage.endCycle;
    const left = (stage.startCycle - leftCycle) * cycleWidth;
    const right = (endCycle - leftCycle) * cycleWidth;
    return {
        left,
        top: (op.id - topOp) * rowHeight + Math.max(0.5, scale),
        width: Math.max(1, right - left),
        height: Math.max(1, rowHeight - Math.max(1, scale * 2)),
    };
}

export class KonataRenderer {
    static readonly OP_W = 32;
    static readonly OP_H = 24;
    private static readonly MIN_SCALE = 0.125;
    private static readonly MAX_SCALE = 4;

    private trace_: ParsedTrace | null = null;
    private left_ = 0;
    private top_ = 0;
    private scale_ = 1;

    setTrace(trace: ParsedTrace | null): void {
        this.trace_ = trace;
        this.resetView();
    }

    resetView(): void {
        this.left_ = 0;
        this.top_ = 0;
        this.scale_ = 1;
    }

    get zoomPercent(): number {
        return Math.round(this.scale_ * 100);
    }

    // pointer位置にあるcycle/opを固定したまま倍率を変える。
    zoomAt(factor: number, posX: number, posY: number): void {
        const oldCycleWidth = this.cycleWidth_;
        const oldRowHeight = this.rowHeight_;
        const logicalX = this.left_ + posX / oldCycleWidth;
        const logicalY = this.top_ + posY / oldRowHeight;

        this.scale_ = Math.max(
            KonataRenderer.MIN_SCALE,
            Math.min(KonataRenderer.MAX_SCALE, this.scale_ * factor),
        );
        this.left_ = logicalX - posX / this.cycleWidth_;
        this.top_ = logicalY - posY / this.rowHeight_;
    }

    // wheelのpixel量を、現在のscaleに対応する論理cycle/opへ変換する。
    panPixels(deltaX: number, deltaY: number): void {
        this.left_ += deltaX / this.cycleWidth_;
        this.top_ += deltaY / this.rowHeight_;
    }

    draw(labelCanvas: HTMLCanvasElement, pipelineCanvas: HTMLCanvasElement): void {
        const label = this.prepareCanvas_(labelCanvas);
        const pipeline = this.prepareCanvas_(pipelineCanvas);
        this.clampView_(pipeline.width, Math.min(label.height, pipeline.height));
        this.drawLabels_(labelCanvas, label);
        this.drawPipeline_(pipelineCanvas, pipeline);
    }

    private get cycleWidth_(): number {
        return KonataRenderer.OP_W * this.scale_;
    }

    private get rowHeight_(): number {
        return KonataRenderer.OP_H * this.scale_;
    }

    private prepareCanvas_(canvas: HTMLCanvasElement): CanvasSize {
        const width = Math.max(1, canvas.clientWidth);
        const height = Math.max(1, canvas.clientHeight);
        const pixelRatio = window.devicePixelRatio || 1;
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

    private clampView_(pipelineWidth: number, canvasHeight: number): void {
        const trace = this.trace_;
        if (trace === null) {
            this.left_ = 0;
            this.top_ = 0;
            return;
        }

        const visibleCycles = pipelineWidth / this.cycleWidth_;
        const visibleOps = canvasHeight / this.rowHeight_;
        this.left_ = Math.max(0, Math.min(this.left_, Math.max(0, trace.lastCycle - visibleCycles + 1)));
        this.top_ = Math.max(0, Math.min(this.top_, Math.max(0, trace.lastID - visibleOps + 1)));
    }

    private drawLabels_(canvas: HTMLCanvasElement, size: CanvasSize): void {
        const context = canvas.getContext("2d");
        if (context === null) {
            return;
        }

        // 背景を先に塗り、命令が存在しない疎なIDもpaneの背景として残す。
        context.fillStyle = darkStyle.labelPane.backgroundColor;
        context.fillRect(0, 0, size.width, size.height);
        if (this.trace_ === null || this.rowHeight_ < 6) {
            return;
        }

        const fontSize = Math.min(Number(darkStyle.fontSize), Number(darkStyle.fontSize) * this.scale_);
        context.font = `${darkStyle.fontStyle} ${fontSize}px ${darkStyle.fontFamily}`;
        context.fillStyle = darkStyle.labelPane.fontColor;
        context.textBaseline = "middle";

        const firstID = Math.floor(this.top_);
        const lastID = Math.min(this.trace_.lastID, Math.ceil(this.top_ + size.height / this.rowHeight_));
        for (let id = firstID; id <= lastID; id++) {
            const op = this.trace_.getOp(id);
            if (op === undefined) {
                continue;
            }
            const y = (id - this.top_) * this.rowHeight_ + this.rowHeight_ / 2;
            const text = formatOpLabel(id, op);
            context.fillText(text, Number(darkStyle.labelPane.marginLeft), y);
        }
    }

    private drawPipeline_(canvas: HTMLCanvasElement, size: CanvasSize): void {
        const context = canvas.getContext("2d");
        if (context === null) {
            return;
        }

        context.fillStyle = darkStyle.pipelinePane.backgroundColor;
        context.fillRect(0, 0, size.width, size.height);
        if (this.trace_ === null) {
            return;
        }

        const firstID = Math.floor(this.top_);
        const lastID = Math.min(this.trace_.lastID, Math.ceil(this.top_ + size.height / this.rowHeight_));
        this.drawCycleGrid_(context, size);

        for (let id = firstID; id <= lastID; id++) {
            const y = (id - this.top_) * this.rowHeight_;
            // 十分な高さがある場合だけ偶数行へstripeを重ね、命令を追いやすくする。
            if (this.rowHeight_ >= 4 && id % 2 === 0) {
                context.fillStyle = darkStyle.pipelinePane.backgroundColorStripeOverlay;
                context.fillRect(0, y, size.width, this.rowHeight_);
            }

            const op = this.trace_.getOp(id);
            if (op !== undefined) {
                this.drawOp_(context, op, y, size.width);
            }
        }

        if (this.rowHeight_ >= 12) {
            this.drawDependencies_(context, firstID, lastID);
        }
    }

    private drawCycleGrid_(context: CanvasRenderingContext2D, size: CanvasSize): void {
        // 縮小時に線が密集しないよう、画面上でおよそ64px以上になるcycle間隔を選ぶ。
        let interval = 1;
        while (interval * this.cycleWidth_ < 64) {
            interval *= 2;
        }
        const firstCycle = Math.ceil(this.left_ / interval) * interval;
        context.strokeStyle = "rgba(255, 255, 255, 0.09)";
        context.lineWidth = 1;
        context.beginPath();
        for (let cycle = firstCycle; cycle <= this.left_ + size.width / this.cycleWidth_; cycle += interval) {
            const x = Math.round((cycle - this.left_) * this.cycleWidth_) + 0.5;
            context.moveTo(x, 0);
            context.lineTo(x, size.height);
        }
        context.stroke();
    }

    private drawOp_(context: CanvasRenderingContext2D, op: Op, y: number, canvasWidth: number): void {
        for (const [laneName, lane] of op.lanes) {
            for (const stage of lane.stages) {
                const rect = calculateStageRect(op, stage, this.left_, this.top_, this.scale_);
                const left = rect.left;
                const right = rect.left + rect.width;
                if (right < 0 || left > canvasWidth) {
                    continue;
                }

                const { width, top, height } = rect;
                const beginColor = this.stageColor_(laneName, stage.name, true);
                const endColor = this.stageColor_(laneName, stage.name, false);
                if (beginColor === endColor || width <= 1) {
                    context.fillStyle = beginColor;
                }
                else {
                    const gradient = context.createLinearGradient(left, 0, left + width, 0);
                    gradient.addColorStop(0, beginColor);
                    gradient.addColorStop(1, endColor);
                    context.fillStyle = gradient;
                }
                context.fillRect(left, top, width, height);

                if (this.rowHeight_ >= 8) {
                    context.strokeStyle = darkStyle.pipelinePane.borderColor;
                    context.lineWidth = Number(darkStyle.pipelinePane.borderWeight);
                    context.strokeRect(left, top, width, height);
                }
                if (this.rowHeight_ >= 16 && width >= 10) {
                    this.drawStageText_(context, stage.name, stage.labels, left, top, width, height);
                }
            }
        }

        if (op.flush) {
            // flush命令であることを示しつつstageの形が残るよう、半透明色を行全体へ重ねる。
            context.fillStyle = darkStyle.pipelinePane.flushedRegionColor;
            context.fillRect(0, y, canvasWidth, this.rowHeight_);
        }
    }

    private drawStageText_(
        context: CanvasRenderingContext2D,
        stageName: string,
        labels: string,
        left: number,
        top: number,
        width: number,
        height: number,
    ): void {
        const fontSize = Number(darkStyle.fontSize) * this.scale_;
        context.save();
        context.beginPath();
        context.rect(left, top, width, height);
        context.clip();
        context.font = `${darkStyle.fontStyle} ${fontSize}px ${darkStyle.fontFamily}`;
        context.fillStyle = darkStyle.pipelinePane.fontColor;
        context.textBaseline = "middle";
        const label = labels === "" ? stageName : `${stageName}: ${labels}`;
        context.fillText(label, left + 3 * this.scale_, top + height / 2);
        context.restore();
    }

    private drawDependencies_(context: CanvasRenderingContext2D, firstID: number, lastID: number): void {
        if (this.trace_ === null) {
            return;
        }
        context.strokeStyle = darkStyle.pipelinePane.arrowColor;
        context.fillStyle = darkStyle.pipelinePane.arrowColor;
        context.lineWidth = Number(darkStyle.pipelinePane.arrowWeight);

        for (let consumerID = firstID; consumerID <= lastID; consumerID++) {
            const consumer = this.trace_.getOp(consumerID);
            if (consumer === undefined) {
                continue;
            }
            for (const dependency of consumer.prods) {
                const producer = this.trace_.getOp(dependency.opID);
                if (producer === undefined || producer.id < firstID || producer.id > lastID) {
                    continue;
                }

                const sourceCycle = producer.prodCycle >= 0 ? producer.prodCycle : dependency.cycle;
                const targetCycle = consumer.consCycle >= 0 ? consumer.consCycle : dependency.cycle;
                const sourceX = (sourceCycle - this.left_) * this.cycleWidth_;
                const targetX = (targetCycle - this.left_) * this.cycleWidth_;
                const sourceY = (producer.id - this.top_ + 0.5) * this.rowHeight_;
                const targetY = (consumer.id - this.top_ + 0.5) * this.rowHeight_;
                context.beginPath();
                context.moveTo(sourceX, sourceY);
                context.lineTo(targetX, targetY);
                context.stroke();

                const direction = targetY >= sourceY ? 1 : -1;
                context.beginPath();
                context.moveTo(targetX, targetY);
                context.lineTo(targetX - 4, targetY - 6 * direction);
                context.lineTo(targetX + 4, targetY - 6 * direction);
                context.closePath();
                context.fill();
            }
        }
    }

    private stageColor_(laneName: string, stageName: string, isBegin: boolean): string {
        if (stageName === "f" || stageName === "stl") {
            return darkStyle.pipelinePane.stallBackgroundColor;
        }

        const stageLevel = this.trace_?.stageLevelMap.get(laneName, stageName);
        const laneID = this.trace_?.stageLevelMap.getLaneID(laneName) ?? 0;
        const level = stageLevel?.appearance ?? 0;
        const color = darkStyle.pipelinePane.stageBackgroundColor;
        // 既存のAuto schemeと同じ、stageの出現段数とlane IDに基づく色相を使う。
        const rate = Number(isBegin ? color.hRateBegin : color.hRateEnd);
        const saturation = Number(isBegin ? color.sBegin : color.sEnd);
        const lightness = Number(isBegin ? color.lBegin : color.lEnd);
        const hue = (250 - level * rate + laneID * 28 * 8 + 3600) % 360;
        return `hsl(${hue},${saturation}%,${lightness}%)`;
    }
}
