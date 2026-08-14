import type { ParsedTrace } from "./model";
import {
    getKonataView,
    KonataRenderMetrics,
    type KonataRenderSpec,
    type KonataView,
} from "./konata_renderer";

// Storeは最終的な描画指定だけを持ち、時間に依存する途中状態はこのクラスへ閉じ込める。
// React側は目標を渡し、各frameで得たSpecを既存Rendererへ接続するだけにする。
export type KonataViewMotion =
    | {
        readonly type: "linear";
        readonly duration: number;
        readonly zoomDuration?: number;
    }
    | {
        readonly type: "zoomAt";
        readonly duration: number;
        readonly centerX: number;
        readonly centerY: number;
    };

export interface KonataViewControllerInput {
    readonly trace: ParsedTrace | null;
    readonly targetSpec: Readonly<KonataRenderSpec>;
    readonly baselineTrace?: ParsedTrace | null;
    readonly baselineTargetSpec?: Readonly<KonataRenderSpec>;
}

export interface KonataViewFrame {
    readonly spec: Readonly<KonataRenderSpec>;
    readonly baselineSpec?: Readonly<KonataRenderSpec>;
    readonly prefetchSpec?: Readonly<KonataRenderSpec>;
    readonly baselinePrefetchSpec?: Readonly<KonataRenderSpec>;
}

export interface KonataAnimationScheduler {
    now(): number;
    request(callback: FrameRequestCallback): number;
    cancel(id: number): void;
}

interface ActiveAnimation {
    readonly from: KonataView;
    readonly baselineFrom?: KonataView;
    readonly motion: Readonly<KonataViewMotion>;
    readonly startedAt: number;
}

const browserAnimationScheduler: KonataAnimationScheduler = {
    now: () => performance.now(),
    request: (callback) => requestAnimationFrame(callback),
    cancel: (id) => cancelAnimationFrame(id),
};

function sameView(left: KonataView, right: KonataView): boolean {
    return left.zoomLevel === right.zoomLevel &&
        left.position[0] === right.position[0] &&
        left.position[1] === right.position[1];
}

function sameOptionalView(left: KonataView | undefined, right: KonataView | undefined): boolean {
    return left === undefined ? right === undefined : right !== undefined && sameView(left, right);
}

function interpolateSpec(
    trace: ParsedTrace | null,
    targetSpec: Readonly<KonataRenderSpec>,
    from: KonataView,
    motion: Readonly<KonataViewMotion>,
    progress: number,
): Readonly<KonataRenderSpec> {
    if (progress >= 1) {
        return targetSpec;
    }
    const zoomProgress = motion.type === "linear" && motion.zoomDuration !== undefined
        ? Math.min(1, progress * motion.duration / motion.zoomDuration)
        : progress;
    const zoomLevel = from.zoomLevel +
        (targetSpec.zoomLevel - from.zoomLevel) * zoomProgress;
    const fromSpec = { ...targetSpec, ...from };
    if (motion.type === "zoomAt") {
        return new KonataRenderMetrics(trace, fromSpec).withZoomLevel(
            zoomLevel,
            motion.centerX,
            motion.centerY,
        );
    }
    return {
        ...targetSpec,
        zoomLevel,
        position: [
            from.position[0] + (targetSpec.position[0] - from.position[0]) * progress,
            from.position[1] + (targetSpec.position[1] - from.position[1]) * progress,
        ],
    };
}

export class KonataViewController {
    private trace_: ParsedTrace | null;
    private baselineTrace_: ParsedTrace | null | undefined;
    private targetSpec_: Readonly<KonataRenderSpec>;
    private baselineTargetSpec_: Readonly<KonataRenderSpec> | undefined;
    private currentSpec_: Readonly<KonataRenderSpec>;
    private currentBaselineSpec_: Readonly<KonataRenderSpec> | undefined;
    private animation_: Readonly<ActiveAnimation> | null = null;
    private frameID_: number | null = null;
    private disposed_ = false;

    constructor(
        input: Readonly<KonataViewControllerInput>,
        private readonly onFrame_: (frame: Readonly<KonataViewFrame>) => void,
        private readonly onTargetChange_: (
            view: KonataView,
            baselineView?: KonataView,
        ) => void,
        private readonly scheduler_: KonataAnimationScheduler = browserAnimationScheduler,
    ) {
        this.trace_ = input.trace;
        this.baselineTrace_ = input.baselineTrace;
        this.targetSpec_ = input.targetSpec;
        this.baselineTargetSpec_ = input.baselineTargetSpec;
        this.currentSpec_ = input.targetSpec;
        this.currentBaselineSpec_ = input.baselineTargetSpec;
    }

    get currentSpec(): Readonly<KonataRenderSpec> {
        return this.currentSpec_;
    }

    get currentBaselineSpec(): Readonly<KonataRenderSpec> | undefined {
        return this.currentBaselineSpec_;
    }

    get targetSpec(): Readonly<KonataRenderSpec> {
        return this.targetSpec_;
    }

    get baselineTargetSpec(): Readonly<KonataRenderSpec> | undefined {
        return this.baselineTargetSpec_;
    }

    sync(input: Readonly<KonataViewControllerInput>): void {
        // StrictModeのeffect再接続では同じinstanceを再利用するため、同期時に再開可能にする。
        this.disposed_ = false;
        const traceChanged = input.trace !== this.trace_ ||
            input.baselineTrace !== this.baselineTrace_;
        const targetChanged = !sameView(input.targetSpec, this.targetSpec_) ||
            !sameOptionalView(input.baselineTargetSpec, this.baselineTargetSpec_);
        this.trace_ = input.trace;
        this.baselineTrace_ = input.baselineTrace;
        this.targetSpec_ = input.targetSpec;
        this.baselineTargetSpec_ = input.baselineTargetSpec;

        // このクラスから通知した目標以外が来た場合は、外側の確定状態を優先して即時追従する。
        if (traceChanged || targetChanged) {
            this.stopAnimation_();
            this.currentSpec_ = input.targetSpec;
            this.currentBaselineSpec_ = input.baselineTargetSpec;
        }
        else {
            // 配色などの非幾何設定は、位置の補間中でも外側の最新値を即時反映する。
            this.currentSpec_ = { ...input.targetSpec, ...getKonataView(this.currentSpec_) };
            this.currentBaselineSpec_ = input.baselineTargetSpec === undefined ||
                this.currentBaselineSpec_ === undefined
                ? input.baselineTargetSpec
                : { ...input.baselineTargetSpec, ...getKonataView(this.currentBaselineSpec_) };
        }
        this.redraw();
    }

    transitionTo(
        target: KonataView,
        baselineTarget: KonataView | undefined,
        motion: Readonly<KonataViewMotion>,
    ): void {
        if (this.disposed_) {
            return;
        }
        if (!Number.isFinite(motion.duration) || motion.duration <= 0) {
            this.setImmediately(target, baselineTarget);
            return;
        }
        this.stopAnimation_();
        const baselineSpec = this.baselineTargetSpec_ ?? this.currentBaselineSpec_;
        this.targetSpec_ = { ...this.targetSpec_, ...target };
        this.baselineTargetSpec_ = baselineSpec === undefined || baselineTarget === undefined
            ? undefined
            : { ...baselineSpec, ...baselineTarget };
        this.animation_ = {
            from: getKonataView(this.currentSpec_),
            baselineFrom: this.currentBaselineSpec_ === undefined
                ? undefined
                : getKonataView(this.currentBaselineSpec_),
            motion,
            startedAt: this.scheduler_.now(),
        };
        // Storeなど外側の状態は開始時点で最終値へ進め、完了通知を不要にする。
        this.onTargetChange_(target, baselineTarget);
        this.drawAt_(this.animation_.startedAt);
    }

    setImmediately(
        target: KonataView,
        baselineTarget?: KonataView,
    ): void {
        if (this.disposed_) {
            return;
        }
        this.stopAnimation_();
        const baselineSpec = this.baselineTargetSpec_ ?? this.currentBaselineSpec_;
        this.targetSpec_ = { ...this.targetSpec_, ...target };
        this.baselineTargetSpec_ = baselineSpec === undefined || baselineTarget === undefined
            ? undefined
            : { ...baselineSpec, ...baselineTarget };
        this.currentSpec_ = this.targetSpec_;
        this.currentBaselineSpec_ = this.baselineTargetSpec_;
        this.onTargetChange_(target, baselineTarget);
        this.redraw();
    }

    // 比較mode切替などでは、外側が既に持つ目標へ描画も追いつかせる。
    finish(): void {
        if (this.disposed_) {
            return;
        }
        this.stopAnimation_();
        this.currentSpec_ = this.targetSpec_;
        this.currentBaselineSpec_ = this.baselineTargetSpec_;
        this.redraw();
    }

    redraw(): void {
        if (this.disposed_) {
            return;
        }
        this.onFrame_({
            spec: this.currentSpec_,
            baselineSpec: this.currentBaselineSpec_,
            prefetchSpec: this.animation_ === null ? undefined : this.targetSpec_,
            baselinePrefetchSpec: this.animation_ === null
                ? undefined
                : this.baselineTargetSpec_,
        });
    }

    dispose(): void {
        this.stopAnimation_();
        this.disposed_ = true;
    }

    private readonly animate_ = (now: number): void => {
        this.frameID_ = null;
        this.drawAt_(now);
    };

    private drawAt_(now: number): void {
        const animation = this.animation_;
        if (animation === null || this.disposed_) {
            return;
        }
        const progress = Math.max(
            0,
            Math.min(1, (now - animation.startedAt) / animation.motion.duration),
        );
        this.currentSpec_ = interpolateSpec(
            this.trace_,
            this.targetSpec_,
            animation.from,
            animation.motion,
            progress,
        );
        this.currentBaselineSpec_ = animation.baselineFrom === undefined ||
            this.baselineTargetSpec_ === undefined
            ? undefined
            : interpolateSpec(
                this.baselineTrace_ ?? null,
                this.baselineTargetSpec_,
                animation.baselineFrom,
                animation.motion,
                progress,
            );
        if (progress >= 1) {
            this.animation_ = null;
        }
        this.redraw();
        if (this.animation_ !== null) {
            this.frameID_ = this.scheduler_.request(this.animate_);
        }
    }

    private stopAnimation_(): void {
        if (this.frameID_ !== null) {
            this.scheduler_.cancel(this.frameID_);
            this.frameID_ = null;
        }
        this.animation_ = null;
    }
}
