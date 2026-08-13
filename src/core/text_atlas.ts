// 繰り返し現れる短い文字列を一度だけCanvasへ描き、等倍BLTで再利用する。
// 命令ラベルのような固有文字列ではなく、stage名と経過cycle数だけを対象にする。

interface AtlasEntry {
    readonly sourceX: number;
    readonly sourceY: number;
    readonly sourceWidth: number;
    readonly sourceHeight: number;
    readonly offsetX: number;
    readonly offsetY: number;
}

export class TextAtlas {
    // backing pixel基準で固定し、高DPI環境でもCanvasごとの使用量を2 MiBに抑える。
    private static readonly WIDTH = 1024;
    private static readonly HEIGHT = 512;
    private static readonly PADDING = 2;

    private canvas_: HTMLCanvasElement | null = null;
    private context_: CanvasRenderingContext2D | null = null;
    private font_ = "";
    private color_ = "";
    private pixelRatio_ = 0;
    private cursorX_ = 0;
    private cursorY_ = 0;
    private rowHeight_ = 0;
    private readonly entries_ = new Map<string, AtlasEntry>();

    drawText(
        target: CanvasRenderingContext2D,
        text: string,
        x: number,
        baselineY: number,
        font: string,
        color: string,
        pixelRatio: number,
        scale = 1,
    ): void {
        if (text.length === 0 || typeof document === "undefined" ||
            !Number.isFinite(scale) || scale <= 0) {
            target.fillText(text, x, baselineY);
            return;
        }
        const context = this.prepare_(font, color, pixelRatio);
        if (context === null || this.canvas_ === null) {
            target.fillText(text, x, baselineY);
            return;
        }

        const entry = this.entries_.get(text) ?? this.add_(text);
        if (entry === null) {
            target.fillText(text, x, baselineY);
            return;
        }
        target.drawImage(
            this.canvas_,
            entry.sourceX,
            entry.sourceY,
            entry.sourceWidth,
            entry.sourceHeight,
            x + entry.offsetX * scale,
            baselineY + entry.offsetY * scale,
            entry.sourceWidth / this.pixelRatio_ * scale,
            entry.sourceHeight / this.pixelRatio_ * scale,
        );
    }

    dispose(): void {
        if (this.canvas_ !== null) {
            this.canvas_.width = 1;
            this.canvas_.height = 1;
        }
        this.canvas_ = null;
        this.context_ = null;
        this.font_ = "";
        this.color_ = "";
        this.pixelRatio_ = 0;
        this.entries_.clear();
    }

    private prepare_(
        font: string,
        color: string,
        pixelRatio: number,
    ): CanvasRenderingContext2D | null {
        if (!Number.isFinite(pixelRatio) || pixelRatio <= 0) {
            return null;
        }
        if (this.canvas_ === null) {
            this.canvas_ = document.createElement("canvas");
            this.canvas_.width = TextAtlas.WIDTH;
            this.canvas_.height = TextAtlas.HEIGHT;
            this.context_ = this.canvas_.getContext("2d");
        }
        const context = this.context_;
        if (context === null) {
            return null;
        }
        if (this.font_ !== font || this.color_ !== color || this.pixelRatio_ !== pixelRatio) {
            this.font_ = font;
            this.color_ = color;
            this.pixelRatio_ = pixelRatio;
            this.clear_();
        }
        return context;
    }

    private clear_(): void {
        const context = this.context_;
        if (context === null) {
            return;
        }
        context.setTransform(1, 0, 0, 1, 0, 0);
        context.clearRect(0, 0, TextAtlas.WIDTH, TextAtlas.HEIGHT);
        context.setTransform(this.pixelRatio_, 0, 0, this.pixelRatio_, 0, 0);
        context.font = this.font_;
        context.fillStyle = this.color_;
        context.textBaseline = "alphabetic";
        this.entries_.clear();
        this.cursorX_ = 0;
        this.cursorY_ = 0;
        this.rowHeight_ = 0;
    }

    private add_(text: string): AtlasEntry | null {
        const context = this.context_;
        if (context === null) {
            return null;
        }
        const metrics = context.measureText(text);
        const fontSize = Number(/([\d.]+)px/.exec(this.font_)?.[1] ?? 12);
        const left = Number.isFinite(metrics.actualBoundingBoxLeft)
            ? metrics.actualBoundingBoxLeft
            : 0;
        const right = Number.isFinite(metrics.actualBoundingBoxRight)
            ? metrics.actualBoundingBoxRight
            : metrics.width;
        const ascent = metrics.actualBoundingBoxAscent > 0
            ? metrics.actualBoundingBoxAscent
            : fontSize;
        const descent = metrics.actualBoundingBoxDescent >= 0
            ? metrics.actualBoundingBoxDescent
            : fontSize * 0.25;
        const ratio = this.pixelRatio_;
        const minX = Math.floor(-left * ratio) - TextAtlas.PADDING;
        const maxX = Math.ceil(right * ratio) + TextAtlas.PADDING;
        const minY = Math.floor(-ascent * ratio) - TextAtlas.PADDING;
        const maxY = Math.ceil(descent * ratio) + TextAtlas.PADDING;
        const width = Math.max(1, maxX - minX);
        const height = Math.max(1, maxY - minY);
        if (width > TextAtlas.WIDTH || height > TextAtlas.HEIGHT) {
            return null;
        }

        if (this.cursorX_ + width > TextAtlas.WIDTH) {
            this.cursorX_ = 0;
            this.cursorY_ += this.rowHeight_;
            this.rowHeight_ = 0;
        }
        if (this.cursorY_ + height > TextAtlas.HEIGHT) {
            // 可視範囲を越えるほど種類が増えた場合も容量を増やさず、atlas領域を再利用する。
            this.clear_();
        }

        const entry: AtlasEntry = {
            sourceX: this.cursorX_,
            sourceY: this.cursorY_,
            sourceWidth: width,
            sourceHeight: height,
            offsetX: minX / ratio,
            offsetY: minY / ratio,
        };
        const baselineX = (this.cursorX_ - minX) / ratio;
        const baselineY = (this.cursorY_ - minY) / ratio;
        context.fillText(text, baselineX, baselineY);
        this.entries_.set(text, entry);
        this.cursorX_ += width;
        this.rowHeight_ = Math.max(this.rowHeight_, height);
        return entry;
    }
}
