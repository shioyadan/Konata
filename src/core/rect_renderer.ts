// Konata固有の描画判断から独立したCanvas描画境界。
// 矩形のbackend選択と、繰り返す短い文字列のrasterize／BLTをこのfileへ閉じる。

export interface RectContext {
    fillStyle: string | CanvasGradient | CanvasPattern;
    strokeStyle: string | CanvasGradient | CanvasPattern;
    lineWidth: number;
    fillRect(x: number, y: number, width: number, height: number): void;
    strokeRect(x: number, y: number, width: number, height: number): void;
    fillVerticalGradientRect(
        x: number,
        y: number,
        width: number,
        height: number,
        topColor: string,
        bottomColor: string,
        topPosition?: number,
        bottomPosition?: number,
    ): void;
}

type WebGLState = "uninitialized" | "ready" | "lost" | "unavailable";

interface AtlasEntry {
    readonly sourceX: number;
    readonly sourceY: number;
    readonly sourceWidth: number;
    readonly sourceHeight: number;
    readonly offsetX: number;
    readonly offsetY: number;
}

class TextAtlas {
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
    private revision_ = 0;
    private generation_ = 0;
    private readonly entries_ = new Map<string, AtlasEntry>();

    get canvas(): HTMLCanvasElement | null {
        return this.canvas_;
    }

    get width(): number {
        return TextAtlas.WIDTH;
    }

    get height(): number {
        return TextAtlas.HEIGHT;
    }

    get revision(): number {
        return this.revision_;
    }

    get generation(): number {
        return this.generation_;
    }

    getEntry(
        text: string,
        font: string,
        color: string,
        pixelRatio: number,
    ): AtlasEntry | null {
        if (text.length === 0 || typeof document === "undefined") {
            return null;
        }
        const context = this.prepare_(font, color, pixelRatio);
        if (context === null || this.canvas_ === null) {
            return null;
        }
        return this.entries_.get(text) ?? this.add_(text);
    }

    drawEntry(
        target: CanvasRenderingContext2D,
        entry: Readonly<AtlasEntry>,
        x: number,
        baselineY: number,
        scale: number,
    ): void {
        if (this.canvas_ === null) {
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
        this.revision_++;
        this.generation_++;
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
        this.revision_++;
        this.generation_++;
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
        this.revision_++;
        return entry;
    }
}

/**
 * rectangleをCanvas互換の形で蓄積し、多数ある時だけWebGL2で一括描画する。
 *
 * WebGLを利用できない場合も同じ矩形列をCanvas 2Dへ再生するため、呼出側はbackendを意識しない。
 * 小さいbatchではWebGLの固定費を避け、Canvas 2Dをそのまま使う。
 */
export class RectRenderer implements RectContext {
    private static readonly WEBGL_RECT_THRESHOLD = 64;
    private static readonly INITIAL_CAPACITY = 2048;

    private targetCanvas_: HTMLCanvasElement | null = null;
    private targetContext_: CanvasRenderingContext2D | null = null;
    private width_ = 1;
    private height_ = 1;
    private webGLEnabled_ = true;
    private fillStyle_: string = "#000000";
    private fillStyleIndex_ = 0;
    private strokeStyle_: string = "#000000";
    private strokeStyleIndex_ = 0;
    private lineWidth_ = 1;
    private styles_: string[] = [];
    private styleMap_ = new Map<string, number>();
    private capacity_ = 0;
    private count_ = 0;
    private rects_ = new Float32Array(0);
    private textureRects_ = new Float32Array(0);
    private textPositions_ = new Float32Array(0);
    private readonly texts_: Array<string | undefined> = [];
    // 1矩形につき上端・下端のstyle indexを持ち、単色では両方を同じ値にする。
    private styleIndices_ = new Uint32Array(0);
    private colors_ = new Uint8Array(0);
    // 0なら塗り、正数ならstroke、-1ならatlas文字として同じ描画順へ積む。
    private strokeWidths_ = new Float32Array(0);
    // 直前のfillだけを結合候補にし、別commandを越えてpainter順を変えない。
    private mergeableFillRight_: number | null = null;
    private textCount_ = 0;
    private textAtlasGeneration_ = -1;
    private textBatchValid_ = true;

    private state_: WebGLState = "uninitialized";
    private overlayCanvas_: HTMLCanvasElement | null = null;
    private gl_: WebGL2RenderingContext | null = null;
    private program_: WebGLProgram | null = null;
    private vertexArray_: WebGLVertexArrayObject | null = null;
    private unitBuffer_: WebGLBuffer | null = null;
    private rectBuffer_: WebGLBuffer | null = null;
    private colorBuffer_: WebGLBuffer | null = null;
    private strokeWidthBuffer_: WebGLBuffer | null = null;
    private textureRectBuffer_: WebGLBuffer | null = null;
    private textTexture_: WebGLTexture | null = null;
    private resolutionUniform_: WebGLUniformLocation | null = null;
    private textAtlasUniform_: WebGLUniformLocation | null = null;
    private uploadedTextAtlasRevision_ = -1;
    private colorCanvas_: HTMLCanvasElement | null = null;
    private colorContext_: CanvasRenderingContext2D | null = null;
    private readonly colorCache_ = new Map<string, readonly [number, number, number, number]>();
    private readonly textAtlas_ = new TextAtlas();
    private textContext_: CanvasRenderingContext2D | null = null;
    private textDisplayFont_ = "";
    private textFont_ = "";
    private textColor_ = "#000000";
    private textPixelRatio_ = 1;
    private textScale_ = 1;
    private textCacheEnabled_ = true;

    get fillStyle(): string | CanvasGradient | CanvasPattern {
        return this.fillStyle_;
    }

    set fillStyle(value: string | CanvasGradient | CanvasPattern) {
        if (typeof value !== "string") {
            throw new Error("The accelerated rectangle layer only supports solid CSS colors.");
        }
        this.fillStyle_ = value;
        this.fillStyleIndex_ = this.getStyleIndex_(value);
    }

    get strokeStyle(): string | CanvasGradient | CanvasPattern {
        return this.strokeStyle_;
    }

    set strokeStyle(value: string | CanvasGradient | CanvasPattern) {
        if (typeof value !== "string") {
            throw new Error("The accelerated rectangle layer only supports solid stroke colors.");
        }
        this.strokeStyle_ = value;
        this.strokeStyleIndex_ = this.getStyleIndex_(value);
    }

    get lineWidth(): number {
        return this.lineWidth_;
    }

    set lineWidth(value: number) {
        if (!Number.isFinite(value) || value <= 0) {
            throw new Error("The accelerated rectangle layer requires a positive line width.");
        }
        this.lineWidth_ = value;
    }

    private getStyleIndex_(value: string): number {
        const existing = this.styleMap_.get(value);
        if (existing !== undefined) {
            return existing;
        }
        const index = this.styles_.length;
        this.styles_.push(value);
        this.styleMap_.set(value, index);
        return index;
    }

    begin(
        canvas: HTMLCanvasElement,
        context: CanvasRenderingContext2D,
        width: number,
        height: number,
        webGLEnabled = true,
    ): RectContext {
        this.targetCanvas_ = canvas;
        this.targetContext_ = context;
        this.width_ = width;
        this.height_ = height;
        this.webGLEnabled_ = webGLEnabled;
        this.count_ = 0;
        this.mergeableFillRight_ = null;
        this.textCount_ = 0;
        this.textAtlasGeneration_ = -1;
        this.textBatchValid_ = true;
        this.styles_ = [];
        this.styleMap_.clear();
        this.fillStyle = "#000000";
        this.strokeStyle = "#000000";
        this.lineWidth = 1;
        return this;
    }

    setTextStyle(
        context: CanvasRenderingContext2D,
        fontStyle: string,
        baseFontSize: number,
        fontFamily: string,
        color: string,
        scale: number,
    ): void {
        const pixelRatio = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;
        const displayFont = `${fontStyle} ${baseFontSize * scale}px ${fontFamily}`;
        // 100%以下では基準glyphを縮小し、zoom animation中の毎frame再生成を避ける。
        // 拡大時はbitmap拡大でぼかさず、実際の表示サイズでrasterizeする。
        const atlasScale = Math.min(1, scale);
        this.textContext_ = context;
        this.textDisplayFont_ = displayFont;
        this.textFont_ = atlasScale < 1
            ? `${fontStyle} ${baseFontSize}px ${fontFamily}`
            : displayFont;
        this.textColor_ = color;
        this.textPixelRatio_ = pixelRatio;
        this.textScale_ = atlasScale;
        context.font = displayFont;
        context.fillStyle = color;
        // 等倍BLTでは半pixel配置を再補間せず、縮小時だけ滑らかにsamplingする。
        context.imageSmoothingEnabled = atlasScale < 1;
    }

    setTextCacheEnabled(enabled: boolean): void {
        if (this.textCacheEnabled_ === enabled) {
            return;
        }
        this.textCacheEnabled_ = enabled;
        if (!enabled) {
            this.textAtlas_.dispose();
        }
    }

    fillText(text: string, x: number, baselineY: number): void {
        const context = this.textContext_;
        if (context === null) {
            return;
        }
        if (!this.textCacheEnabled_) {
            // stage矩形の描画で変更されたCanvas stateを、直接文字描画の前に戻す。
            context.font = this.textDisplayFont_;
            context.fillStyle = this.textColor_;
            context.textBaseline = "alphabetic";
            context.fillText(text, x, baselineY);
            return;
        }
        if (this.targetContext_ === context) {
            this.queueText_(text, x, baselineY);
            return;
        }
        this.drawText_(context, text, x, baselineY);
    }

    fillRect(x: number, y: number, width: number, height: number): void {
        this.queueRect_(x, y, width, height, this.fillStyleIndex_, this.fillStyleIndex_);
    }

    strokeRect(x: number, y: number, width: number, height: number): void {
        this.queueRect_(
            x,
            y,
            width,
            height,
            this.strokeStyleIndex_,
            this.strokeStyleIndex_,
            this.lineWidth_,
        );
    }

    fillVerticalGradientRect(
        x: number,
        y: number,
        width: number,
        height: number,
        topColor: string,
        bottomColor: string,
        topPosition = 0,
        bottomPosition = 1,
    ): void {
        this.queueRect_(
            x,
            y,
            width,
            height,
            this.getStyleIndex_(topColor),
            this.getStyleIndex_(bottomColor),
            0,
            topPosition,
            bottomPosition,
        );
    }

    private queueRect_(
        x: number,
        y: number,
        width: number,
        height: number,
        topStyleIndex: number,
        bottomStyleIndex: number,
        strokeWidth = 0,
        gradientTopPosition = 0,
        gradientBottomPosition = 0,
    ): void {
        if (![x, y, width, height].every(Number.isFinite) || width === 0 || height === 0) {
            return;
        }
        if (width < 0) {
            x += width;
            width = -width;
        }
        if (height < 0) {
            y += height;
            height = -height;
        }
        if (strokeWidth === 0 && this.count_ > 0 && this.mergeableFillRight_ === x) {
            const previousIndex = this.count_ - 1;
            const previousOffset = previousIndex * 4;
            const previousStyleOffset = previousIndex * 2;
            // 同じ縦gradientが水平に接する場合、1矩形へしても最終画素は変わらない。
            // 重なる矩形は半透明色のblend回数が変わるため、接する場合だけを対象にする。
            if (this.strokeWidths_[previousIndex] === 0 &&
                this.styleIndices_[previousStyleOffset] === topStyleIndex &&
                this.styleIndices_[previousStyleOffset + 1] === bottomStyleIndex &&
                this.rects_[previousOffset + 1] === Math.fround(y) &&
                this.rects_[previousOffset + 3] === Math.fround(height) &&
                this.textureRects_[previousOffset] === Math.fround(gradientTopPosition) &&
                this.textureRects_[previousOffset + 1] === Math.fround(gradientBottomPosition)) {
                const right = x + width;
                this.rects_[previousOffset + 2] = right - this.rects_[previousOffset];
                this.mergeableFillRight_ = right;
                return;
            }
        }
        if (this.count_ >= this.capacity_) {
            this.grow_();
        }
        const offset = this.count_ * 4;
        this.rects_[offset] = x;
        this.rects_[offset + 1] = y;
        this.rects_[offset + 2] = width;
        this.rects_[offset + 3] = height;
        const styleOffset = this.count_ * 2;
        this.styleIndices_[styleOffset] = topStyleIndex;
        this.styleIndices_[styleOffset + 1] = bottomStyleIndex;
        this.strokeWidths_[this.count_] = strokeWidth;
        this.textureRects_[offset] = gradientTopPosition;
        this.textureRects_[offset + 1] = gradientBottomPosition;
        this.textureRects_[offset + 2] = 0;
        this.textureRects_[offset + 3] = 0;
        this.texts_[this.count_] = undefined;
        this.count_++;
        this.mergeableFillRight_ = strokeWidth === 0 ? x + width : null;
    }

    private queueText_(text: string, x: number, baselineY: number): void {
        this.mergeableFillRight_ = null;
        if (this.count_ >= this.capacity_) {
            this.grow_();
        }
        const index = this.count_;
        const offset = index * 4;
        const textOffset = index * 2;
        const entry = this.textAtlas_.getEntry(
            text,
            this.textFont_,
            this.textColor_,
            this.textPixelRatio_,
        );
        if (entry === null || !Number.isFinite(this.textScale_) || this.textScale_ <= 0) {
            this.rects_.fill(0, offset, offset + 4);
            this.textureRects_.fill(0, offset, offset + 4);
            this.textBatchValid_ = false;
        }
        else {
            const generation = this.textAtlas_.generation;
            if (this.textAtlasGeneration_ < 0) {
                this.textAtlasGeneration_ = generation;
            }
            else if (this.textAtlasGeneration_ !== generation) {
                // atlasが同じframe中に一周した場合、先に記録したUVは無効なのでCanvasへ戻す。
                this.textBatchValid_ = false;
            }
            this.rects_[offset] = x + entry.offsetX * this.textScale_;
            this.rects_[offset + 1] = baselineY + entry.offsetY * this.textScale_;
            this.rects_[offset + 2] = entry.sourceWidth / this.textPixelRatio_ * this.textScale_;
            this.rects_[offset + 3] = entry.sourceHeight / this.textPixelRatio_ * this.textScale_;
            this.textureRects_[offset] = entry.sourceX / this.textAtlas_.width;
            this.textureRects_[offset + 1] = entry.sourceY / this.textAtlas_.height;
            this.textureRects_[offset + 2] = entry.sourceWidth / this.textAtlas_.width;
            this.textureRects_[offset + 3] = entry.sourceHeight / this.textAtlas_.height;
        }
        this.styleIndices_[textOffset] = 0;
        this.styleIndices_[textOffset + 1] = 0;
        this.strokeWidths_[index] = -1;
        this.textPositions_[textOffset] = x;
        this.textPositions_[textOffset + 1] = baselineY;
        this.texts_[index] = text;
        this.count_++;
        this.textCount_++;
    }

    private drawText_(
        context: CanvasRenderingContext2D,
        text: string,
        x: number,
        baselineY: number,
    ): void {
        const entry = this.textAtlas_.getEntry(
            text,
            this.textFont_,
            this.textColor_,
            this.textPixelRatio_,
        );
        if (entry !== null && Number.isFinite(this.textScale_) && this.textScale_ > 0) {
            this.textAtlas_.drawEntry(context, entry, x, baselineY, this.textScale_);
            return;
        }
        context.font = this.textDisplayFont_;
        context.fillStyle = this.textColor_;
        context.textBaseline = "alphabetic";
        context.fillText(text, x, baselineY);
    }

    end(): void {
        if (this.targetCanvas_ === null || this.targetContext_ === null) {
            return;
        }
        const useWebGL = this.webGLEnabled_ &&
            this.textBatchValid_ &&
            this.count_ >= RectRenderer.WEBGL_RECT_THRESHOLD &&
            this.ensureWebGL_() &&
            this.drawWebGL_();
        if (!useWebGL) {
            this.drawCanvas2D_();
        }
        this.texts_.fill(undefined, 0, this.count_);
        this.targetCanvas_ = null;
        this.targetContext_ = null;
        this.count_ = 0;
    }

    dispose(): void {
        this.textAtlas_.dispose();
        this.textContext_ = null;
        this.gl_?.getExtension("WEBGL_lose_context")?.loseContext();
        if (this.overlayCanvas_ !== null) {
            this.overlayCanvas_.width = 1;
            this.overlayCanvas_.height = 1;
        }
        this.state_ = "uninitialized";
        this.gl_ = null;
        this.program_ = null;
        this.vertexArray_ = null;
        this.unitBuffer_ = null;
        this.rectBuffer_ = null;
        this.colorBuffer_ = null;
        this.strokeWidthBuffer_ = null;
        this.textureRectBuffer_ = null;
        this.textTexture_ = null;
        this.resolutionUniform_ = null;
        this.textAtlasUniform_ = null;
        this.uploadedTextAtlasRevision_ = -1;
        this.overlayCanvas_ = null;
    }

    private grow_(): void {
        const capacity = Math.max(RectRenderer.INITIAL_CAPACITY, this.capacity_ * 2);
        const rects = new Float32Array(capacity * 4);
        const textureRects = new Float32Array(capacity * 4);
        const textPositions = new Float32Array(capacity * 2);
        const indices = new Uint32Array(capacity * 2);
        const colors = new Uint8Array(capacity * 8);
        const strokeWidths = new Float32Array(capacity);
        rects.set(this.rects_.subarray(0, this.count_ * 4));
        textureRects.set(this.textureRects_.subarray(0, this.count_ * 4));
        textPositions.set(this.textPositions_.subarray(0, this.count_ * 2));
        indices.set(this.styleIndices_.subarray(0, this.count_ * 2));
        colors.set(this.colors_.subarray(0, this.count_ * 8));
        strokeWidths.set(this.strokeWidths_.subarray(0, this.count_));
        this.rects_ = rects;
        this.textureRects_ = textureRects;
        this.textPositions_ = textPositions;
        this.styleIndices_ = indices;
        this.colors_ = colors;
        this.strokeWidths_ = strokeWidths;
        this.capacity_ = capacity;
    }

    private drawCanvas2D_(): void {
        const context = this.targetContext_;
        if (context === null) {
            return;
        }
        let solidStyleIndex = -1;
        let strokeStyleIndex = -1;
        let lineWidth = -1;
        for (let index = 0; index < this.count_; index++) {
            const offset = index * 4;
            const styleOffset = index * 2;
            const topStyleIndex = this.styleIndices_[styleOffset];
            const bottomStyleIndex = this.styleIndices_[styleOffset + 1];
            const strokeWidth = this.strokeWidths_[index];
            if (strokeWidth < 0) {
                const text = this.texts_[index];
                if (text !== undefined) {
                    this.drawText_(
                        context,
                        text,
                        this.textPositions_[styleOffset],
                        this.textPositions_[styleOffset + 1],
                    );
                }
                // 直接fillTextへfallbackした場合に変更されるCanvas stateを次の矩形で再設定する。
                solidStyleIndex = -1;
                strokeStyleIndex = -1;
                continue;
            }
            if (strokeWidth > 0) {
                if (topStyleIndex !== strokeStyleIndex) {
                    context.strokeStyle = this.styles_[topStyleIndex];
                    strokeStyleIndex = topStyleIndex;
                }
                if (strokeWidth !== lineWidth) {
                    context.lineWidth = strokeWidth;
                    lineWidth = strokeWidth;
                }
                context.strokeRect(
                    this.rects_[offset],
                    this.rects_[offset + 1],
                    this.rects_[offset + 2],
                    this.rects_[offset + 3],
                );
                continue;
            }
            const gradientTopPosition = this.textureRects_[offset];
            const gradientBottomPosition = this.textureRects_[offset + 1];
            if (gradientTopPosition === gradientBottomPosition) {
                if (topStyleIndex !== solidStyleIndex) {
                    context.fillStyle = this.styles_[topStyleIndex];
                    solidStyleIndex = topStyleIndex;
                }
            }
            else {
                const gradientHeight = this.rects_[offset + 3] /
                    (gradientBottomPosition - gradientTopPosition);
                const gradientTop = this.rects_[offset + 1] -
                    gradientTopPosition * gradientHeight;
                const gradient = context.createLinearGradient(
                    0,
                    gradientTop,
                    0,
                    gradientTop + gradientHeight,
                );
                gradient.addColorStop(0, this.styles_[topStyleIndex]);
                gradient.addColorStop(1, this.styles_[bottomStyleIndex]);
                context.fillStyle = gradient;
                solidStyleIndex = -1;
            }
            context.fillRect(
                this.rects_[offset],
                this.rects_[offset + 1],
                this.rects_[offset + 2],
                this.rects_[offset + 3],
            );
        }
    }

    private ensureWebGL_(): boolean {
        if (this.state_ === "ready") {
            return this.gl_ !== null && !this.gl_.isContextLost();
        }
        if (this.state_ === "lost" || this.state_ === "unavailable" || typeof document === "undefined") {
            return false;
        }

        const canvas = this.overlayCanvas_ ?? document.createElement("canvas");
        if (this.overlayCanvas_ === null) {
            canvas.addEventListener("webglcontextlost", (event) => {
                if (this.overlayCanvas_ !== canvas) {
                    return;
                }
                event.preventDefault();
                this.state_ = "lost";
            });
            canvas.addEventListener("webglcontextrestored", () => {
                if (this.overlayCanvas_ !== canvas) {
                    return;
                }
                this.state_ = "uninitialized";
                this.clearGLResources_();
            });
            this.overlayCanvas_ = canvas;
        }
        const gl = canvas.getContext("webgl2", {
            alpha: true,
            antialias: false,
            depth: false,
            stencil: false,
            premultipliedAlpha: true,
            preserveDrawingBuffer: true,
        }) as WebGL2RenderingContext | null;
        if (gl === null) {
            this.state_ = "unavailable";
            return false;
        }
        this.gl_ = gl;
        try {
            this.initializeGL_();
            this.state_ = "ready";
            return true;
        }
        catch {
            this.state_ = "unavailable";
            this.clearGLResources_();
            return false;
        }
    }

    private initializeGL_(): void {
        const gl = this.gl_;
        if (gl === null) {
            throw new Error("A WebGL2 context is required.");
        }
        const vertexShader = this.compileShader_(gl.VERTEX_SHADER, `#version 300 es
            layout(location=0) in vec2 a_unit;
            layout(location=1) in vec4 a_rect;
            layout(location=2) in vec4 a_color_top;
            layout(location=3) in vec4 a_color_bottom;
            layout(location=4) in float a_stroke_width;
            layout(location=5) in vec4 a_texture_rect;
            uniform vec2 u_resolution;
            out vec4 v_color;
            out vec2 v_position;
            out vec2 v_texture_position;
            flat out vec2 v_rect_size;
            flat out float v_stroke_width;
            void main() {
                float padding = a_stroke_width > 0.0 ? a_stroke_width * 0.5 + 1.0 : 0.0;
                vec2 size = a_rect.zw + vec2(padding * 2.0);
                vec2 position = a_rect.xy - vec2(padding) + a_unit * size;
                vec2 clip = position / u_resolution * 2.0 - 1.0;
                gl_Position = vec4(clip * vec2(1.0, -1.0), 0.0, 1.0);
                float color_position = mix(a_texture_rect.x, a_texture_rect.y, a_unit.y);
                v_color = mix(a_color_top, a_color_bottom, color_position);
                v_position = -vec2(padding) + a_unit * size;
                v_texture_position = a_texture_rect.xy + a_unit * a_texture_rect.zw;
                v_rect_size = a_rect.zw;
                v_stroke_width = a_stroke_width;
            }
        `);
        const fragmentShader = this.compileShader_(gl.FRAGMENT_SHADER, `#version 300 es
            precision highp float;
            uniform sampler2D u_text_atlas;
            in vec4 v_color;
            in vec2 v_position;
            in vec2 v_texture_position;
            flat in vec2 v_rect_size;
            flat in float v_stroke_width;
            out vec4 out_color;
            void main() {
                if (v_stroke_width < 0.0) {
                    out_color = texture(u_text_atlas, v_texture_position);
                    if (out_color.a <= 0.0) {
                        discard;
                    }
                    return;
                }
                if (v_stroke_width > 0.0) {
                    float half_width = v_stroke_width * 0.5;
                    vec2 outer_distance = min(
                        v_position + vec2(half_width),
                        v_rect_size + vec2(half_width) - v_position
                    );
                    vec2 inner_distance = min(
                        v_position - vec2(half_width),
                        v_rect_size - vec2(half_width) - v_position
                    );
                    float outer_edge = min(outer_distance.x, outer_distance.y);
                    float inner_edge = min(inner_distance.x, inner_distance.y);
                    float outer_aa = max(fwidth(outer_edge), 0.0001);
                    float inner_aa = max(fwidth(inner_edge), 0.0001);
                    // 境界のcoverageを滑らかに補間し、縮小時も枠へ階段状のaliasを出さない。
                    float outer_coverage = smoothstep(-outer_aa * 0.5, outer_aa * 0.5, outer_edge);
                    float inner_coverage = smoothstep(-inner_aa * 0.5, inner_aa * 0.5, inner_edge);
                    float coverage = outer_coverage * (1.0 - inner_coverage);
                    if (coverage <= 0.0) {
                        discard;
                    }
                    out_color = vec4(v_color.rgb, v_color.a * coverage);
                    return;
                }
                out_color = v_color;
            }
        `);
        const program = gl.createProgram();
        if (program === null) {
            throw new Error("A WebGL program could not be created.");
        }
        gl.attachShader(program, vertexShader);
        gl.attachShader(program, fragmentShader);
        gl.linkProgram(program);
        gl.deleteShader(vertexShader);
        gl.deleteShader(fragmentShader);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
            const message = gl.getProgramInfoLog(program) ?? "Unknown WebGL link error.";
            gl.deleteProgram(program);
            throw new Error(message);
        }

        const vertexArray = gl.createVertexArray();
        const unitBuffer = gl.createBuffer();
        const rectBuffer = gl.createBuffer();
        const colorBuffer = gl.createBuffer();
        const strokeWidthBuffer = gl.createBuffer();
        const textureRectBuffer = gl.createBuffer();
        const textTexture = gl.createTexture();
        if (vertexArray === null || unitBuffer === null || rectBuffer === null ||
            colorBuffer === null || strokeWidthBuffer === null || textureRectBuffer === null ||
            textTexture === null) {
            throw new Error("WebGL buffers could not be created.");
        }
        this.program_ = program;
        this.vertexArray_ = vertexArray;
        this.unitBuffer_ = unitBuffer;
        this.rectBuffer_ = rectBuffer;
        this.colorBuffer_ = colorBuffer;
        this.strokeWidthBuffer_ = strokeWidthBuffer;
        this.textureRectBuffer_ = textureRectBuffer;
        this.textTexture_ = textTexture;
        this.resolutionUniform_ = gl.getUniformLocation(program, "u_resolution");
        this.textAtlasUniform_ = gl.getUniformLocation(program, "u_text_atlas");
        this.uploadedTextAtlasRevision_ = -1;

        gl.bindVertexArray(vertexArray);
        gl.bindBuffer(gl.ARRAY_BUFFER, unitBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
            0, 0, 1, 0, 0, 1,
            0, 1, 1, 0, 1, 1,
        ]), gl.STATIC_DRAW);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

        gl.bindBuffer(gl.ARRAY_BUFFER, rectBuffer);
        gl.enableVertexAttribArray(1);
        gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 0, 0);
        gl.vertexAttribDivisor(1, 1);

        gl.bindBuffer(gl.ARRAY_BUFFER, colorBuffer);
        gl.enableVertexAttribArray(2);
        gl.vertexAttribPointer(2, 4, gl.UNSIGNED_BYTE, true, 8, 0);
        gl.vertexAttribDivisor(2, 1);
        gl.enableVertexAttribArray(3);
        gl.vertexAttribPointer(3, 4, gl.UNSIGNED_BYTE, true, 8, 4);
        gl.vertexAttribDivisor(3, 1);

        gl.bindBuffer(gl.ARRAY_BUFFER, strokeWidthBuffer);
        gl.enableVertexAttribArray(4);
        gl.vertexAttribPointer(4, 1, gl.FLOAT, false, 0, 0);
        gl.vertexAttribDivisor(4, 1);

        gl.bindBuffer(gl.ARRAY_BUFFER, textureRectBuffer);
        gl.enableVertexAttribArray(5);
        gl.vertexAttribPointer(5, 4, gl.FLOAT, false, 0, 0);
        gl.vertexAttribDivisor(5, 1);
        gl.bindVertexArray(null);

        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, textTexture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texImage2D(
            gl.TEXTURE_2D,
            0,
            gl.RGBA,
            1,
            1,
            0,
            gl.RGBA,
            gl.UNSIGNED_BYTE,
            new Uint8Array(4),
        );
    }

    private compileShader_(type: number, source: string): WebGLShader {
        const gl = this.gl_;
        if (gl === null) {
            throw new Error("A WebGL2 context is required.");
        }
        const shader = gl.createShader(type);
        if (shader === null) {
            throw new Error("A WebGL shader could not be created.");
        }
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
            const message = gl.getShaderInfoLog(shader) ?? "Unknown WebGL shader error.";
            gl.deleteShader(shader);
            throw new Error(message);
        }
        return shader;
    }

    private drawWebGL_(): boolean {
        const gl = this.gl_;
        const overlay = this.overlayCanvas_;
        const target = this.targetCanvas_;
        const targetContext = this.targetContext_;
        if (gl === null || overlay === null || target === null || targetContext === null ||
            this.program_ === null || this.vertexArray_ === null ||
            this.rectBuffer_ === null || this.colorBuffer_ === null ||
            this.strokeWidthBuffer_ === null || this.textureRectBuffer_ === null ||
            this.textTexture_ === null || gl.isContextLost()) {
            return false;
        }
        if (!this.prepareColors_()) {
            return false;
        }

        try {
            if (overlay.width !== target.width || overlay.height !== target.height) {
                overlay.width = target.width;
                overlay.height = target.height;
            }
            gl.viewport(0, 0, overlay.width, overlay.height);
            gl.disable(gl.DEPTH_TEST);
            gl.disable(gl.CULL_FACE);
            gl.enable(gl.BLEND);
            gl.blendFuncSeparate(
                gl.SRC_ALPHA,
                gl.ONE_MINUS_SRC_ALPHA,
                gl.ONE,
                gl.ONE_MINUS_SRC_ALPHA,
            );
            gl.clearColor(0, 0, 0, 0);
            gl.clear(gl.COLOR_BUFFER_BIT);
            gl.useProgram(this.program_);
            gl.uniform2f(this.resolutionUniform_, this.width_, this.height_);
            gl.uniform1i(this.textAtlasUniform_, 0);
            if (!this.prepareTextTexture_()) {
                return false;
            }
            gl.bindVertexArray(this.vertexArray_);
            gl.bindBuffer(gl.ARRAY_BUFFER, this.rectBuffer_);
            gl.bufferData(
                gl.ARRAY_BUFFER,
                this.rects_.subarray(0, this.count_ * 4),
                gl.DYNAMIC_DRAW,
            );
            gl.bindBuffer(gl.ARRAY_BUFFER, this.colorBuffer_);
            gl.bufferData(
                gl.ARRAY_BUFFER,
                this.colors_.subarray(0, this.count_ * 8),
                gl.DYNAMIC_DRAW,
            );
            gl.bindBuffer(gl.ARRAY_BUFFER, this.strokeWidthBuffer_);
            gl.bufferData(
                gl.ARRAY_BUFFER,
                this.strokeWidths_.subarray(0, this.count_),
                gl.DYNAMIC_DRAW,
            );
            gl.bindBuffer(gl.ARRAY_BUFFER, this.textureRectBuffer_);
            gl.bufferData(
                gl.ARRAY_BUFFER,
                this.textureRects_.subarray(0, this.count_ * 4),
                gl.DYNAMIC_DRAW,
            );
            gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, this.count_);
            gl.bindVertexArray(null);

            targetContext.save();
            try {
                targetContext.setTransform(1, 0, 0, 1, 0, 0);
                targetContext.globalAlpha = 1;
                targetContext.globalCompositeOperation = "source-over";
                targetContext.imageSmoothingEnabled = false;
                targetContext.drawImage(overlay, 0, 0);
            }
            finally {
                targetContext.restore();
            }
            return true;
        }
        catch {
            this.state_ = gl.isContextLost() ? "lost" : "unavailable";
            return false;
        }
    }

    private prepareTextTexture_(): boolean {
        const gl = this.gl_;
        const texture = this.textTexture_;
        if (gl === null || texture === null) {
            return false;
        }
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        const filter = this.textScale_ < 1 ? gl.LINEAR : gl.NEAREST;
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
        if (this.textCount_ === 0) {
            return true;
        }
        const atlas = this.textAtlas_.canvas;
        if (atlas === null || this.textAtlasGeneration_ !== this.textAtlas_.generation) {
            return false;
        }
        if (this.uploadedTextAtlasRevision_ !== this.textAtlas_.revision) {
            // 画面上端のvertexへUV 0を対応させているため、Canvas sourceの上下は反転しない。
            gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
            gl.texImage2D(
                gl.TEXTURE_2D,
                0,
                gl.RGBA,
                gl.RGBA,
                gl.UNSIGNED_BYTE,
                atlas,
            );
            this.uploadedTextAtlasRevision_ = this.textAtlas_.revision;
        }
        return true;
    }

    private prepareColors_(): boolean {
        const palette: Array<readonly [number, number, number, number]> = [];
        for (const style of this.styles_) {
            const color = this.parseColor_(style);
            if (color === null) {
                return false;
            }
            palette.push(color);
        }
        for (let index = 0; index < this.count_; index++) {
            const colorOffset = index * 8;
            if (this.strokeWidths_[index] < 0) {
                this.colors_.fill(0, colorOffset, colorOffset + 8);
                continue;
            }
            const styleOffset = index * 2;
            const topColor = palette[this.styleIndices_[styleOffset]];
            const bottomColor = palette[this.styleIndices_[styleOffset + 1]];
            this.colors_[colorOffset] = topColor[0];
            this.colors_[colorOffset + 1] = topColor[1];
            this.colors_[colorOffset + 2] = topColor[2];
            this.colors_[colorOffset + 3] = topColor[3];
            this.colors_[colorOffset + 4] = bottomColor[0];
            this.colors_[colorOffset + 5] = bottomColor[1];
            this.colors_[colorOffset + 6] = bottomColor[2];
            this.colors_[colorOffset + 7] = bottomColor[3];
        }
        return true;
    }

    private parseColor_(style: string): readonly [number, number, number, number] | null {
        const cached = this.colorCache_.get(style);
        if (cached !== undefined) {
            return cached;
        }
        if (typeof document === "undefined") {
            return null;
        }
        if (this.colorContext_ === null) {
            this.colorCanvas_ = document.createElement("canvas");
            this.colorCanvas_.width = 1;
            this.colorCanvas_.height = 1;
            this.colorContext_ = this.colorCanvas_.getContext("2d", { willReadFrequently: true });
        }
        const context = this.colorContext_;
        if (context === null) {
            return null;
        }
        try {
            context.clearRect(0, 0, 1, 1);
            context.fillStyle = "#000000";
            context.fillStyle = style;
            context.fillRect(0, 0, 1, 1);
            const data = context.getImageData(0, 0, 1, 1).data;
            const color = [data[0], data[1], data[2], data[3]] as const;
            this.colorCache_.set(style, color);
            return color;
        }
        catch {
            return null;
        }
    }

    private clearGLResources_(): void {
        this.gl_ = null;
        this.program_ = null;
        this.vertexArray_ = null;
        this.unitBuffer_ = null;
        this.rectBuffer_ = null;
        this.colorBuffer_ = null;
        this.strokeWidthBuffer_ = null;
        this.textureRectBuffer_ = null;
        this.textTexture_ = null;
        this.resolutionUniform_ = null;
        this.textAtlasUniform_ = null;
        this.uploadedTextAtlasRevision_ = -1;
    }
}
