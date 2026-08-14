// Pipelineの描画内容には立ち入らず、既存KonataRendererの完成画像をタイル単位で再利用する。
// この層が知るのはworld上の画素座標と完成Canvasだけであり、Op／stageの意味や描画順は
// KonataRendererへ残す。これによりRendererの品質を変えず、同じ領域の再描画だけを省ける。
// スクロール／zoom中は直前画像を即座に移動・拡縮し、不足タイルだけを後続frameで生成する。

import darkStyle from "../../theme/dark/style.json";
import lightStyle from "../../theme/light/style.json";
import type { ParsedTrace } from "./model";
import {
    DEP_ARROW_TYPE,
    getFirstDrawingRow,
    KonataRenderMetrics,
    type KonataRenderSpec,
    KonataRenderer,
} from "./konata_renderer";

export interface TiledPipelineRenderOptions {
    // 読み込み中または互換設定で無効な時は、tileを残さずRendererで直接描画する。
    readonly cacheEnabled: boolean;
    // 比較用offscreen CanvasにはCSS寸法がないため、表示先と同じ論理寸法を明示する。
    readonly width?: number;
    readonly height?: number;
    readonly colorScheme?: string;
    readonly referenceOnly?: boolean;
    readonly webGLEnabled: boolean;
    // 現在の表示と異なる既知のSpecがあれば、その倍率のtileを先読みする。
    readonly prefetchSpec?: Readonly<KonataRenderSpec>;
    // 比較用offscreen layerが更新された時に、表示Canvasの再合成を依頼する。
    readonly onUpdate?: () => void;
}

interface Tile {
    readonly canvas: HTMLCanvasElement;
    readonly bytes: number;
}

interface TilePosition {
    readonly x: number;
    readonly y: number;
    readonly visible: boolean;
    readonly priority: number;
}

interface TileScreenBounds {
    readonly left: number;
    readonly top: number;
    readonly right: number;
    readonly bottom: number;
}

interface TileNamespace {
    readonly key: string;
    readonly contentKey: string;
    readonly opWidth: number;
    readonly opHeight: number;
}

interface RenderRequest {
    readonly trace: ParsedTrace;
    readonly spec: Readonly<KonataRenderSpec>;
    readonly canvas: HTMLCanvasElement;
    readonly width: number;
    readonly height: number;
    readonly pixelRatio: number;
    readonly metrics: KonataRenderMetrics;
    // positionを現在倍率のworld pixelへ変換し、tile境界を命令／cycle境界から独立させる。
    readonly worldX: number;
    readonly worldY: number;
    // contentKeyは全倍率で共通の描画条件、namespaceKeyは倍率ごとのtile座標系を表す。
    readonly contentKey: string;
    readonly namespaceKey: string;
    readonly colorScheme?: string;
    readonly referenceOnly: boolean;
    readonly webGLEnabled: boolean;
    readonly onUpdate?: () => void;
}

interface PreviousBase {
    // 矢印を重ねる前のviewportを保持し、次の操作へ低遅延の暫定画像として使う。
    readonly canvas: HTMLCanvasElement;
    readonly contentKey: string;
    readonly position: readonly [number, number];
    readonly opWidth: number;
    readonly opHeight: number;
    readonly width: number;
    readonly height: number;
}

/**
 * KonataRendererとCanvas所有componentの間で、pipeline本体だけをraster tileとしてcacheする。
 *
 * 依存矢印は任意のタイルを横断するためcacheへ含めず、完成したviewportへ最後に重ねる。
 * traceを変更しながら読む期間は呼出側がcacheを無効にし、完成後の不変traceだけを保持する。
 * tileは表示品質を決める描画器ではなく、同じ入力の完成画素を再利用する配送単位である。
 */
export class TiledPipelineRenderer {
    // vis_hpcgの3%表示では1命令内のstageが非常に多いため、1 jobを短く保つ256 pxを使う。
    private static readonly TILE_SIZE = 256;
    // 小scrollで未描画領域を露出させないため、可視範囲の全方向へ1 tileだけ先読みする。
    private static readonly PREFETCH_MARGIN_TILES = 1;
    private static readonly MAX_CACHE_BYTES = 128 * 1024 * 1024;
    private static readonly SCALE_SETTLE_DELAY_MS = 80;
    // 軽いtileは同じframeで進め、重いtileではUI時間を残す。GLの非同期実行を積み過ぎないよう枚数も制限する。
    private static readonly VISIBLE_RENDER_BUDGET_MS = 8;
    private static readonly VISIBLE_MAX_TILES_PER_FRAME = 8;
    private static readonly PREFETCH_RENDER_BUDGET_MS = 4;
    private static readonly PREFETCH_MAX_TILES_PER_FRAME = 2;

    private readonly renderer_: KonataRenderer;
    // Mapの挿入順をLRU順として兼用し、別のqueueや世代表を増やさない。
    private readonly tiles_ = new Map<string, Tile>();
    private cacheBytes_ = 0;
    private trace_: ParsedTrace | null = null;
    private contentKey_ = "";
    private namespaceKey_ = "";
    private current_: RenderRequest | null = null;
    private build_: RenderRequest | null = null;
    private prefetching_ = false;
    // 最後に可視範囲が完成した倍率を、次の倍率が揃うまでのsource tile群として保持する。
    private fallbackNamespace_: TileNamespace | null = null;
    private previousBase_: PreviousBase | null = null;
    private jobs_: TilePosition[] = [];
    private generation_ = 0;
    private frameID_: number | null = null;
    private settleTimerID_: number | null = null;

    constructor(renderer: KonataRenderer) {
        this.renderer_ = renderer;
    }

    drawPipelineSpec(
        trace: ParsedTrace | null,
        spec: Readonly<KonataRenderSpec>,
        canvas: HTMLCanvasElement,
        options: Readonly<TiledPipelineRenderOptions>,
    ): void {
        if (!options.cacheEnabled || trace === null || typeof document === "undefined") {
            this.clear();
            this.renderer_.drawPipelineSpec(
                trace,
                spec,
                canvas,
                options.width,
                options.height,
                options.colorScheme,
                options.referenceOnly ?? false,
                options.webGLEnabled,
            );
            return;
        }

        const width = Math.max(1, options.width ?? canvas.clientWidth);
        const height = Math.max(1, options.height ?? canvas.clientHeight);
        const pixelRatio = window.devicePixelRatio || 1;
        const metrics = new KonataRenderMetrics(trace, spec);
        const contentKey = this.makeContentKey_(spec, options, pixelRatio);
        const namespaceKey = `${contentKey}|zoom:${spec.zoomLevel}`;
        // 色等の変更は全tileを破棄するが、zoom変更は元倍率のtileをLRUに残す。
        // 元の倍率へ戻った時に再利用でき、zoom中の暫定画像にも直前viewportを使える。
        const contentChanged = this.trace_ !== trace || this.contentKey_ !== contentKey;
        const namespaceChanged = contentChanged || this.namespaceKey_ !== namespaceKey;

        if (contentChanged) {
            this.cancelJobs_();
            this.generation_++;
            this.build_ = null;
            this.clearCache_();
            this.clearPreviousBase_();
            this.trace_ = trace;
            this.contentKey_ = contentKey;
        }
        if (namespaceChanged) {
            this.namespaceKey_ = namespaceKey;
        }

        const current: RenderRequest = {
            trace,
            spec,
            canvas,
            width,
            height,
            pixelRatio,
            metrics,
            worldX: spec.position[0] * metrics.opWidth,
            worldY: spec.position[1] * metrics.opHeight,
            contentKey,
            namespaceKey,
            colorScheme: options.colorScheme,
            referenceOnly: options.referenceOnly ?? false,
            webGLEnabled: options.webGLEnabled,
            onUpdate: options.onUpdate,
        };
        this.current_ = current;
        const prefetchSpec = options.prefetchSpec;
        const prefetchMetrics = prefetchSpec === undefined
            ? null
            : new KonataRenderMetrics(trace, prefetchSpec);
        const prefetch: RenderRequest | null = prefetchSpec === undefined || prefetchMetrics === null
            ? null
            : {
                ...current,
                spec: prefetchSpec,
                metrics: prefetchMetrics,
                worldX: prefetchSpec.position[0] * prefetchMetrics.opWidth,
                worldY: prefetchSpec.position[1] * prefetchMetrics.opHeight,
                namespaceKey: `${contentKey}|zoom:${prefetchSpec.zoomLevel}`,
            };
        const build = prefetch ?? current;
        const buildChanged = this.build_?.namespaceKey !== build.namespaceKey;
        if (buildChanged) {
            this.cancelJobs_();
            this.generation_++;
        }
        this.build_ = build;
        this.prefetching_ = prefetch !== null && prefetch.namespaceKey !== current.namespaceKey;
        this.paint_(false);
        this.rebuildJobs_(build);
        this.scheduleNext_(!this.prefetching_ && buildChanged && namespaceChanged && !contentChanged);
    }

    clear(): void {
        this.cancelJobs_();
        this.generation_++;
        this.current_ = null;
        this.build_ = null;
        this.prefetching_ = false;
        this.trace_ = null;
        this.contentKey_ = "";
        this.namespaceKey_ = "";
        this.clearCache_();
        this.clearPreviousBase_();
    }

    private makeContentKey_(
        spec: Readonly<KonataRenderSpec>,
        options: Readonly<TiledPipelineRenderOptions>,
        pixelRatio: number,
    ): string {
        // positionはtile座標へ、zoomはnamespaceへ分離する。依存矢印の設定もoverlayだけを
        // 描き直せばよいため含めず、base tileを無用に破棄しない。
        return JSON.stringify({
            theme: spec.theme,
            colorScheme: spec.colorScheme,
            customColorScheme: spec.customColorScheme,
            splitLanes: spec.splitLanes,
            fixOpHeight: spec.fixOpHeight,
            hideFlushedOps: spec.hideFlushedOps,
            textLabelMinimumLaneHeight: spec.textLabelMinimumLaneHeight,
            stageDetailMinimumLaneHeight: spec.stageDetailMinimumLaneHeight,
            stageBorderMinimumLaneHeight: spec.stageBorderMinimumLaneHeight,
            renderingColorScheme: options.colorScheme ?? null,
            referenceOnly: options.referenceOnly ?? false,
            webGLEnabled: options.webGLEnabled,
            pixelRatio,
        });
    }

    private prepareTarget_(request: RenderRequest): CanvasRenderingContext2D | null {
        const backingWidth = Math.max(1, Math.round(request.width * request.pixelRatio));
        const backingHeight = Math.max(1, Math.round(request.height * request.pixelRatio));
        if (request.canvas.width !== backingWidth || request.canvas.height !== backingHeight) {
            request.canvas.width = backingWidth;
            request.canvas.height = backingHeight;
        }
        const context = request.canvas.getContext("2d");
        context?.setTransform(request.pixelRatio, 0, 0, request.pixelRatio, 0, 0);
        return context;
    }

    private paint_(notify: boolean): void {
        const request = this.current_;
        if (request === null) {
            return;
        }
        const context = this.prepareTarget_(request);
        if (context === null) {
            return;
        }
        context.clearRect(0, 0, request.width, request.height);
        if (!request.referenceOnly) {
            const style = request.spec.theme === "light" ? lightStyle : darkStyle;
            context.fillStyle = style.pipelinePane.backgroundColor;
            context.fillRect(0, 0, request.width, request.height);
        }

        // zoom中の暫定画像だけは滑らかに拡縮し、同倍率の完成tileはpixel境界を保って置く。
        const previous = this.previousBase_;
        context.imageSmoothingEnabled = previous !== null &&
            (previous.opWidth !== request.metrics.opWidth || previous.opHeight !== request.metrics.opHeight);
        const previousCoverage = this.drawPreviousBase_(context, request);
        context.imageSmoothingEnabled = false;
        let reusedCoverage = previousCoverage;
        const fallback = this.fallbackNamespace_;
        if (fallback !== null && fallback.key !== request.namespaceKey) {
            reusedCoverage = Math.max(
                reusedCoverage,
                this.drawNamespaceTiles_(context, request, fallback),
            );
        }
        const build = this.build_;
        if (this.prefetching_ && build !== null && build.namespaceKey !== request.namespaceKey &&
            build.namespaceKey !== fallback?.key) {
            reusedCoverage = Math.max(
                reusedCoverage,
                this.drawNamespaceTiles_(context, request, this.getNamespace_(build), build),
            );
        }
        let tileCount = 0;
        let hasMissingInstructionTile = false;
        for (const tilePosition of this.getTilePositions_(request, false)) {
            const tile = this.getTile_(
                this.tileKey_(request.namespaceKey, tilePosition.x, tilePosition.y),
            );
            if (tile !== undefined) {
                // cache済みtileでは、同じOp範囲を空判定のためだけに再走査しない。
                this.drawTileCanvas_(
                    context,
                    request,
                    tile.canvas,
                    this.getTileScreenBounds_(request, tilePosition.x, tilePosition.y),
                );
                tileCount++;
                continue;
            }
            if (!this.tileContainsInstruction_(request, tilePosition)) {
                // 空領域は安価な背景だけを毎回描き、raster cache容量を消費しない。
                this.drawEmptyTile_(context, request, tilePosition);
                continue;
            }
            hasMissingInstructionTile = true;
        }
        if (tileCount > 0 && !hasMissingInstructionTile) {
            this.fallbackNamespace_ = this.getNamespace_(request);
        }

        // 初回や大きなjumpでは再利用画素がほぼない。全tile完成まで空白を見せるより、
        // 従来の全体描画を一度だけ使い、その後の操作からcacheの利益を得る。
        if (tileCount === 0 && hasMissingInstructionTile &&
            reusedCoverage < request.width * request.height * 0.25) {
            this.renderer_.drawPipelineSpec(
                request.trace,
                request.spec,
                request.canvas,
                request.width,
                request.height,
                request.colorScheme,
                request.referenceOnly,
                request.webGLEnabled,
                "base",
            );
        }
        // dependency passを含む画像を保存すると次のframeで古い矢印が残るため、ここでbaseだけを退避する。
        this.capturePreviousBase_(request);

        // 矢印はviewport全体の座標で描くことで、tile境界で曲線が切れることを避ける。
        if (!request.referenceOnly && request.spec.dependencyArrowType !== DEP_ARROW_TYPE.NOT_SHOW) {
            this.renderer_.drawPipelineSpec(
                request.trace,
                request.spec,
                request.canvas,
                request.width,
                request.height,
                request.colorScheme,
                false,
                request.webGLEnabled,
                "dependencies",
            );
        }
        // 範囲外色を空tileごとにclipすると、subpixel上の境界が背景と混ざって格子に見える。
        // viewport全体へ最後に一度だけ描き、tileと矢印のどちらも同じ境界で覆う。
        this.drawInvalidBackground_(context, request);
        if (notify) {
            request.onUpdate?.();
        }
    }

    private drawPreviousBase_(
        context: CanvasRenderingContext2D,
        request: RenderRequest,
    ): number {
        const previous = this.previousBase_;
        if (previous === null || previous.contentKey !== request.contentKey) {
            return 0;
        }
        // 論理positionの差を現在倍率の画素へ変換する。zoomが変わった時だけ画像寸法も変える。
        const scaleX = request.metrics.opWidth / previous.opWidth;
        const scaleY = request.metrics.opHeight / previous.opHeight;
        const x = (previous.position[0] - request.spec.position[0]) * request.metrics.opWidth;
        const y = (previous.position[1] - request.spec.position[1]) * request.metrics.opHeight;
        const width = previous.width * scaleX;
        const height = previous.height * scaleY;
        context.drawImage(previous.canvas, x, y, width, height);
        const intersectionWidth = Math.max(0, Math.min(request.width, x + width) - Math.max(0, x));
        const intersectionHeight = Math.max(0, Math.min(request.height, y + height) - Math.max(0, y));
        return intersectionWidth * intersectionHeight;
    }

    private getNamespace_(request: RenderRequest): TileNamespace {
        return {
            key: request.namespaceKey,
            contentKey: request.contentKey,
            opWidth: request.metrics.opWidth,
            opHeight: request.metrics.opHeight,
        };
    }

    private drawNamespaceTiles_(
        context: CanvasRenderingContext2D,
        request: RenderRequest,
        namespace: TileNamespace,
        sourceViewport?: RenderRequest,
    ): number {
        if (namespace.contentKey !== request.contentKey || namespace.opWidth <= 0 || namespace.opHeight <= 0) {
            return 0;
        }
        const size = TiledPipelineRenderer.TILE_SIZE;
        const scaleX = request.metrics.opWidth / namespace.opWidth;
        const scaleY = request.metrics.opHeight / namespace.opHeight;
        let coverage = 0;
        context.imageSmoothingEnabled = scaleX !== 1 || scaleY !== 1;
        const drawTile = (x: number, y: number) => {
            const tile = this.getTile_(this.tileKey_(namespace.key, x, y));
            if (tile === undefined) {
                return;
            }
            // source倍率のworld tileを論理座標へ戻し、現在倍率の画素位置へ再投影する。
            const bounds = this.getTileScreenBounds_(request, x, y, scaleX, scaleY);
            this.drawTileCanvas_(context, request, tile.canvas, bounds, scaleX, scaleY);
            coverage += Math.max(0, Math.min(request.width, bounds.right) - Math.max(0, bounds.left)) *
                Math.max(0, Math.min(request.height, bounds.bottom) - Math.max(0, bounds.top));
        };
        if (sourceViewport !== undefined) {
            // 終点倍率の先読みは、終点viewport用に生成するtileだけを途中画像へ再投影する。
            // 現在viewportを終点の細かいtile座標へ展開すると、極端な倍率差で探索数が膨張する。
            for (const position of this.getTilePositions_(sourceViewport, false)) {
                drawTile(position.x, position.y);
            }
        }
        else {
            const sourceWorldX = request.spec.position[0] * namespace.opWidth;
            const sourceWorldY = request.spec.position[1] * namespace.opHeight;
            const left = Math.floor(sourceWorldX / size);
            const top = Math.floor(sourceWorldY / size);
            const right = Math.floor((sourceWorldX + request.width / scaleX - Number.EPSILON) / size);
            const bottom = Math.floor((sourceWorldY + request.height / scaleY - Number.EPSILON) / size);
            for (let y = top; y <= bottom; y++) {
                for (let x = left; x <= right; x++) {
                    drawTile(x, y);
                }
            }
        }
        context.imageSmoothingEnabled = false;
        return Math.min(request.width * request.height, coverage);
    }

    private capturePreviousBase_(request: RenderRequest): void {
        // backing store同士を等倍copyし、devicePixelRatioによる二重scaleを避ける。
        const previousCanvas = this.previousBase_?.canvas ?? document.createElement("canvas");
        if (previousCanvas.width !== request.canvas.width || previousCanvas.height !== request.canvas.height) {
            previousCanvas.width = request.canvas.width;
            previousCanvas.height = request.canvas.height;
        }
        const context = previousCanvas.getContext("2d");
        if (context === null) {
            return;
        }
        context.setTransform(1, 0, 0, 1, 0, 0);
        context.clearRect(0, 0, previousCanvas.width, previousCanvas.height);
        context.drawImage(request.canvas, 0, 0);
        this.previousBase_ = {
            canvas: previousCanvas,
            contentKey: request.contentKey,
            position: request.spec.position,
            opWidth: request.metrics.opWidth,
            opHeight: request.metrics.opHeight,
            width: request.width,
            height: request.height,
        };
    }

    private rebuildJobs_(request: RenderRequest): void {
        // 可視tileを先に完成させた後、同じqueueで外周1 tileを低優先度に先読みする。
        this.jobs_ = this.getTilePositions_(request, true)
            .filter((position) => !this.tiles_.has(
                this.tileKey_(request.namespaceKey, position.x, position.y),
            ))
            .filter((position) => this.tileContainsInstruction_(request, position))
            .sort((left, right) => left.priority - right.priority);
    }

    private getTilePositions_(request: RenderRequest, includeMargin: boolean): TilePosition[] {
        const size = TiledPipelineRenderer.TILE_SIZE;
        const visibleLeft = Math.floor(request.worldX / size);
        const visibleTop = Math.floor(request.worldY / size);
        const visibleRight = Math.floor((request.worldX + request.width - Number.EPSILON) / size);
        const visibleBottom = Math.floor((request.worldY + request.height - Number.EPSILON) / size);
        const margin = includeMargin ? TiledPipelineRenderer.PREFETCH_MARGIN_TILES : 0;
        const centerX = (request.worldX + request.width / 2) / size;
        const centerY = (request.worldY + request.height / 2) / size;
        const positions: TilePosition[] = [];
        for (let y = visibleTop - margin; y <= visibleBottom + margin; y++) {
            for (let x = visibleLeft - margin; x <= visibleRight + margin; x++) {
                const visible = x >= visibleLeft && x <= visibleRight &&
                    y >= visibleTop && y <= visibleBottom;
                positions.push({
                    x,
                    y,
                    visible,
                    priority: (visible ? 0 : 1_000_000) +
                        (x + 0.5 - centerX) ** 2 + (y + 0.5 - centerY) ** 2,
                });
            }
        }
        return positions;
    }

    private tileContainsInstruction_(request: RenderRequest, position: TilePosition): boolean {
        const size = TiledPipelineRenderer.TILE_SIZE;
        const logicalTop = position.y * size / request.metrics.opHeight;
        const logicalBottom = (position.y + 1) * size / request.metrics.opHeight;
        const top = Math.max(0, Math.floor(logicalTop));
        const bottom = Math.min(request.metrics.getVisibleBottom(), Math.ceil(logicalBottom) - 1);
        if (top > bottom) {
            return false;
        }
        const left = position.x * size / request.metrics.opWidth;
        const right = (position.x + 1) * size / request.metrics.opWidth;
        // Renderer本体と同じ命令だけを調べる。ここだけ全命令を走査すると、最縮小域では
        // 1 tileが数万命令を覆い、実描画より空判定の方が大幅に重くなる。
        const step = request.metrics.drawingStep;
        const firstY = getFirstDrawingRow(top, step);
        for (let y = firstY; y <= bottom; y += step) {
            const op = request.metrics.getVisibleOp(y, request.metrics.opResolution);
            if (op !== undefined && op.retiredCycle !== op.fetchedCycle &&
                op.retiredCycle >= left && op.fetchedCycle <= right) {
                return true;
            }
        }
        return false;
    }

    private drawEmptyTile_(
        context: CanvasRenderingContext2D,
        request: RenderRequest,
        position: TilePosition,
    ): void {
        const size = TiledPipelineRenderer.TILE_SIZE;
        const bounds = this.getTileScreenBounds_(request, position.x, position.y);
        // 半透明stripeを重ねて濃くしないよう、空tileは共通辺をdevice pixelへ揃えて隙間だけを消す。
        const ratio = request.pixelRatio;
        const left = Math.round(bounds.left * ratio) / ratio;
        const top = Math.round(bounds.top * ratio) / ratio;
        const right = Math.round(bounds.right * ratio) / ratio;
        const bottom = Math.round(bounds.bottom * ratio) / ratio;
        context.save();
        context.beginPath();
        context.rect(left, top, right - left, bottom - top);
        context.clip();
        if (request.referenceOnly) {
            // 比較の参照layerは背景を持たないため、移動前の暫定画素だけを消す。
            context.clearRect(left, top, right - left, bottom - top);
            context.restore();
            return;
        }

        const style = request.spec.theme === "light" ? lightStyle : darkStyle;
        context.fillStyle = style.pipelinePane.backgroundColor;
        context.fillRect(left, top, right - left, bottom - top);
        if (request.metrics.canDrawFrame) {
            // 命令がなくても旧Rendererは偶数行のstripeを描くため、背景の見た目だけは直接再現する。
            const logicalTop = Math.max(0, Math.floor(position.y * size / request.metrics.opHeight));
            const logicalBottom = Math.ceil((position.y + 1) * size / request.metrics.opHeight);
            context.fillStyle = style.pipelinePane.backgroundColorStripeOverlay;
            for (let y = logicalTop; y < logicalBottom; y++) {
                if (y % 2 === 0) {
                    context.fillRect(
                        0,
                        (y - request.spec.position[1]) * request.metrics.opHeight + 0.5,
                        request.width,
                        request.metrics.opHeight,
                    );
                }
            }
        }

        context.restore();
    }

    private getTileScreenBounds_(
        request: RenderRequest,
        x: number,
        y: number,
        scaleX = 1,
        scaleY = 1,
    ): TileScreenBounds {
        const size = TiledPipelineRenderer.TILE_SIZE;
        // left+丸めたwidthではなく、隣接tileが共有する両辺を同じworld変換から直接求める。
        return {
            left: x * size * scaleX - request.worldX,
            top: y * size * scaleY - request.worldY,
            right: (x + 1) * size * scaleX - request.worldX,
            bottom: (y + 1) * size * scaleY - request.worldY,
        };
    }

    private drawTileCanvas_(
        context: CanvasRenderingContext2D,
        request: RenderRequest,
        canvas: HTMLCanvasElement,
        bounds: TileScreenBounds,
        scaleX = 1,
        scaleY = 1,
    ): void {
        // 文字を描く安定倍率は共有辺の整列だけにして再scaleしない。補間するzoom画像と
        // 文字のない縮小域では不透明tileを半device pixelずつ重ね、背景の隙間を残さない。
        const scaled = scaleX !== 1 || scaleY !== 1;
        const overlap = !request.referenceOnly && (scaled || !request.metrics.canDrawText)
            ? 0.5 / request.pixelRatio
            : 0;
        const ratio = request.pixelRatio;
        const left = Math.round(bounds.left * ratio) / ratio - overlap;
        const top = Math.round(bounds.top * ratio) / ratio - overlap;
        const right = Math.round(bounds.right * ratio) / ratio + overlap;
        const bottom = Math.round(bounds.bottom * ratio) / ratio + overlap;
        context.drawImage(canvas, left, top, right - left, bottom - top);
    }

    private drawInvalidBackground_(
        context: CanvasRenderingContext2D,
        request: RenderRequest,
    ): void {
        if (request.referenceOnly) {
            return;
        }
        const style = request.spec.theme === "light" ? lightStyle : darkStyle;
        context.fillStyle = style.pipelinePane.invalidBackgroundColor;
        if (request.spec.position[1] < 0) {
            const bottom = Math.min(
                request.height,
                -request.spec.position[1] * request.metrics.opHeight + 0.5,
            );
            context.fillRect(0, 0, request.width, bottom);
        }
        const logicalHeight = request.height / request.metrics.opHeight;
        const bottomOuterHeight = request.spec.position[1] + logicalHeight - 1 -
            request.metrics.getVisibleBottom();
        if (bottomOuterHeight > 0) {
            const begin = Math.max(
                0,
                request.height - bottomOuterHeight * request.metrics.opHeight + 0.5,
            );
            context.fillRect(0, begin, request.width, request.height);
        }
    }

    private scheduleNext_(deferForScaleChanges: boolean): void {
        if (this.jobs_.length === 0 || this.current_ === null ||
            this.frameID_ !== null || this.settleTimerID_ !== null) {
            return;
        }
        if (deferForScaleChanges) {
            // 目標Specのない連続zoomでは、倍率が安定するまで中間tileの生成を遅らせる。
            this.settleTimerID_ = window.setTimeout(() => {
                this.settleTimerID_ = null;
                this.requestFrame_();
            }, TiledPipelineRenderer.SCALE_SETTLE_DELAY_MS);
            return;
        }
        this.requestFrame_();
    }

    private requestFrame_(): void {
        if (this.frameID_ !== null) {
            return;
        }
        this.frameID_ = window.requestAnimationFrame(() => {
            this.frameID_ = null;
            this.renderNextBatch_();
        });
    }

    private renderNextBatch_(): void {
        const request = this.build_;
        const generation = this.generation_;
        const firstJob = this.jobs_[0];
        if (request === null || firstJob === undefined) {
            return;
        }
        const visibleBatch = firstJob.visible;
        const budget = visibleBatch
            ? TiledPipelineRenderer.VISIBLE_RENDER_BUDGET_MS
            : TiledPipelineRenderer.PREFETCH_RENDER_BUDGET_MS;
        // 現在と異なる先読み倍率は、入力frameを塞がないよう1枚ずつ生成する。
        const limit = this.prefetching_
            ? 1
            : visibleBatch
            ? TiledPipelineRenderer.VISIBLE_MAX_TILES_PER_FRAME
            : TiledPipelineRenderer.PREFETCH_MAX_TILES_PER_FRAME;
        const begin = performance.now();
        let renderedCount = 0;
        let visibleUpdated = false;

        while (renderedCount < limit) {
            const job = this.jobs_[0];
            // 可視分の最後と先読みを同じbatchへ混ぜず、次frameから小さい先読み予算へ切り替える。
            if (job === undefined || job.visible !== visibleBatch) {
                break;
            }
            this.jobs_.shift();
            if (this.renderTile_(request, job, generation)) {
                renderedCount++;
                visibleUpdated ||= job.visible;
            }
            if (renderedCount > 0 && performance.now() - begin >= budget) {
                break;
            }
        }

        // viewport全体のBLTと依存矢印はtileごとでなくbatch後に一度だけ行う。
        if (visibleUpdated) {
            this.paint_(true);
        }
        this.scheduleNext_(false);
    }

    private renderTile_(request: RenderRequest, job: TilePosition, generation: number): boolean {
        const key = this.tileKey_(request.namespaceKey, job.x, job.y);
        if (this.tiles_.has(key)) {
            return false;
        }
        const canvas = document.createElement("canvas");
        // tile左上のworld pixelをRendererの論理positionへ戻す。Renderer自身はtileの存在を知らない。
        const position: readonly [number, number] = [
            job.x * TiledPipelineRenderer.TILE_SIZE / request.metrics.opWidth,
            job.y * TiledPipelineRenderer.TILE_SIZE / request.metrics.opHeight,
        ];
        this.renderer_.drawPipelineSpec(
            request.trace,
            { ...request.spec, position },
            canvas,
            TiledPipelineRenderer.TILE_SIZE,
            TiledPipelineRenderer.TILE_SIZE,
            request.colorScheme,
            request.referenceOnly,
            request.webGLEnabled,
            "base",
        );
        if (generation !== this.generation_ || this.build_?.namespaceKey !== request.namespaceKey) {
            canvas.width = 1;
            canvas.height = 1;
            return false;
        }
        this.putTile_(key, {
            canvas,
            bytes: canvas.width * canvas.height * 4,
        });
        return true;
    }

    private tileKey_(namespaceKey: string, x: number, y: number): string {
        return `${namespaceKey}|${x},${y}`;
    }

    private getTile_(key: string): Tile | undefined {
        const tile = this.tiles_.get(key);
        if (tile === undefined) {
            return undefined;
        }
        // Mapの挿入順をLRUとして使い、参照したtileを末尾へ移す。
        this.tiles_.delete(key);
        this.tiles_.set(key, tile);
        return tile;
    }

    private putTile_(key: string, tile: Tile): void {
        const previous = this.tiles_.get(key);
        if (previous !== undefined) {
            this.cacheBytes_ -= previous.bytes;
            previous.canvas.width = 1;
            previous.canvas.height = 1;
            this.tiles_.delete(key);
        }
        this.tiles_.set(key, tile);
        this.cacheBytes_ += tile.bytes;
        while (this.cacheBytes_ > TiledPipelineRenderer.MAX_CACHE_BYTES) {
            const oldest = this.tiles_.entries().next().value as [string, Tile] | undefined;
            if (oldest === undefined) {
                break;
            }
            this.tiles_.delete(oldest[0]);
            this.cacheBytes_ -= oldest[1].bytes;
            // DOMから外したCanvasもbacking storeを保持するため、退避時に明示的に縮める。
            oldest[1].canvas.width = 1;
            oldest[1].canvas.height = 1;
        }
    }

    private cancelJobs_(): void {
        this.jobs_ = [];
        if (this.frameID_ !== null) {
            window.cancelAnimationFrame(this.frameID_);
            this.frameID_ = null;
        }
        if (this.settleTimerID_ !== null) {
            window.clearTimeout(this.settleTimerID_);
            this.settleTimerID_ = null;
        }
    }

    private clearCache_(): void {
        for (const tile of this.tiles_.values()) {
            tile.canvas.width = 1;
            tile.canvas.height = 1;
        }
        this.tiles_.clear();
        this.cacheBytes_ = 0;
        this.fallbackNamespace_ = null;
    }

    private clearPreviousBase_(): void {
        if (this.previousBase_ !== null) {
            this.previousBase_.canvas.width = 1;
            this.previousBase_.canvas.height = 1;
        }
        this.previousBase_ = null;
    }
}
