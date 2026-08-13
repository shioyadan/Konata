// Konata固有の描画判断から独立した、solid rectangle用のCanvas互換境界。
// 呼出側はfillStyle／fillRectだけを使い、WebGL2とCanvas 2Dの選択をこのfileへ閉じる。

export interface RectContext {
    fillStyle: string | CanvasGradient | CanvasPattern;
    fillRect(x: number, y: number, width: number, height: number): void;
}

type WebGLState = "uninitialized" | "ready" | "lost" | "unavailable";

/**
 * solid rectangleをCanvas互換の形で蓄積し、多数ある時だけWebGL2で一括描画する。
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
    private fillStyle_: string = "#000000";
    private fillStyleIndex_ = 0;
    private styles_: string[] = [];
    private styleMap_ = new Map<string, number>();
    private capacity_ = 0;
    private count_ = 0;
    private rects_ = new Float32Array(0);
    private styleIndices_ = new Uint32Array(0);
    private colors_ = new Uint8Array(0);

    private state_: WebGLState = "uninitialized";
    private overlayCanvas_: HTMLCanvasElement | null = null;
    private gl_: WebGL2RenderingContext | null = null;
    private program_: WebGLProgram | null = null;
    private vertexArray_: WebGLVertexArrayObject | null = null;
    private unitBuffer_: WebGLBuffer | null = null;
    private rectBuffer_: WebGLBuffer | null = null;
    private colorBuffer_: WebGLBuffer | null = null;
    private resolutionUniform_: WebGLUniformLocation | null = null;
    private colorCanvas_: HTMLCanvasElement | null = null;
    private colorContext_: CanvasRenderingContext2D | null = null;
    private readonly colorCache_ = new Map<string, readonly [number, number, number, number]>();

    get fillStyle(): string | CanvasGradient | CanvasPattern {
        return this.fillStyle_;
    }

    set fillStyle(value: string | CanvasGradient | CanvasPattern) {
        if (typeof value !== "string") {
            throw new Error("The accelerated rectangle layer only supports solid CSS colors.");
        }
        this.fillStyle_ = value;
        const existing = this.styleMap_.get(value);
        if (existing !== undefined) {
            this.fillStyleIndex_ = existing;
            return;
        }
        this.fillStyleIndex_ = this.styles_.length;
        this.styles_.push(value);
        this.styleMap_.set(value, this.fillStyleIndex_);
    }

    begin(
        canvas: HTMLCanvasElement,
        context: CanvasRenderingContext2D,
        width: number,
        height: number,
    ): RectContext {
        this.targetCanvas_ = canvas;
        this.targetContext_ = context;
        this.width_ = width;
        this.height_ = height;
        this.count_ = 0;
        this.styles_ = [];
        this.styleMap_.clear();
        this.fillStyle = "#000000";
        return this;
    }

    fillRect(x: number, y: number, width: number, height: number): void {
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
        if (this.count_ >= this.capacity_) {
            this.grow_();
        }
        const offset = this.count_ * 4;
        this.rects_[offset] = x;
        this.rects_[offset + 1] = y;
        this.rects_[offset + 2] = width;
        this.rects_[offset + 3] = height;
        this.styleIndices_[this.count_] = this.fillStyleIndex_;
        this.count_++;
    }

    end(): void {
        if (this.targetCanvas_ === null || this.targetContext_ === null) {
            return;
        }
        const useWebGL = this.count_ >= RectRenderer.WEBGL_RECT_THRESHOLD &&
            this.ensureWebGL_() &&
            this.drawWebGL_();
        if (!useWebGL) {
            this.drawCanvas2D_();
        }
        this.targetCanvas_ = null;
        this.targetContext_ = null;
        this.count_ = 0;
    }

    dispose(): void {
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
        this.resolutionUniform_ = null;
        this.overlayCanvas_ = null;
    }

    private grow_(): void {
        const capacity = Math.max(RectRenderer.INITIAL_CAPACITY, this.capacity_ * 2);
        const rects = new Float32Array(capacity * 4);
        const indices = new Uint32Array(capacity);
        const colors = new Uint8Array(capacity * 4);
        rects.set(this.rects_.subarray(0, this.count_ * 4));
        indices.set(this.styleIndices_.subarray(0, this.count_));
        colors.set(this.colors_.subarray(0, this.count_ * 4));
        this.rects_ = rects;
        this.styleIndices_ = indices;
        this.colors_ = colors;
        this.capacity_ = capacity;
    }

    private drawCanvas2D_(): void {
        const context = this.targetContext_;
        if (context === null) {
            return;
        }
        let styleIndex = -1;
        for (let index = 0; index < this.count_; index++) {
            const nextStyleIndex = this.styleIndices_[index];
            if (nextStyleIndex !== styleIndex) {
                context.fillStyle = this.styles_[nextStyleIndex];
                styleIndex = nextStyleIndex;
            }
            const offset = index * 4;
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
            layout(location=2) in vec4 a_color;
            uniform vec2 u_resolution;
            out vec4 v_color;
            void main() {
                vec2 position = a_rect.xy + a_unit * a_rect.zw;
                vec2 clip = position / u_resolution * 2.0 - 1.0;
                gl_Position = vec4(clip * vec2(1.0, -1.0), 0.0, 1.0);
                v_color = a_color;
            }
        `);
        const fragmentShader = this.compileShader_(gl.FRAGMENT_SHADER, `#version 300 es
            precision mediump float;
            in vec4 v_color;
            out vec4 out_color;
            void main() {
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
        if (vertexArray === null || unitBuffer === null || rectBuffer === null || colorBuffer === null) {
            throw new Error("WebGL buffers could not be created.");
        }
        this.program_ = program;
        this.vertexArray_ = vertexArray;
        this.unitBuffer_ = unitBuffer;
        this.rectBuffer_ = rectBuffer;
        this.colorBuffer_ = colorBuffer;
        this.resolutionUniform_ = gl.getUniformLocation(program, "u_resolution");

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
        gl.vertexAttribPointer(2, 4, gl.UNSIGNED_BYTE, true, 0, 0);
        gl.vertexAttribDivisor(2, 1);
        gl.bindVertexArray(null);
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
            this.rectBuffer_ === null || this.colorBuffer_ === null || gl.isContextLost()) {
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
                this.colors_.subarray(0, this.count_ * 4),
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
            const color = palette[this.styleIndices_[index]];
            const offset = index * 4;
            this.colors_[offset] = color[0];
            this.colors_[offset + 1] = color[1];
            this.colors_[offset + 2] = color[2];
            this.colors_[offset + 3] = color[3];
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
        this.resolutionUniform_ = null;
    }
}
