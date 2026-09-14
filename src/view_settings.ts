import {
    DEFAULT_CUSTOM_COLOR_SCHEME,
    DEP_ARROW_TYPE,
    type CustomColorComponent,
    type CustomColorDefinition,
    type CustomColorScheme,
} from "./core/konata_renderer";
import {
    DEFAULT_PERSISTED_VIEW_SETTINGS,
    DEFAULT_TRACE_NAVIGATOR_SETTINGS,
    MIN_TRACE_NAVIGATOR_HEIGHT,
    MIN_INSTRUCTION_NAVIGATOR_WIDTH,
    type PersistedViewSettings,
    type TraceNavigatorSettings,
} from "./store";

// 保存データの検証・旧形式の移行はDOMから分離し、単体で検査できるようにする。
const PIPELINE_COLOR_SCHEMES = new Set([
    "Unique",
    "Depth",
    "ThreadID",
    "Orange",
    "RoyalBlue",
    "Custom",
]);
function isNonNegativeFiniteNumber(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isPositiveFiniteNumber(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isCustomColorComponent(value: unknown): value is CustomColorComponent {
    return value === "auto" ||
        (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100);
}

function isCustomColorDefinition(value: unknown): value is CustomColorDefinition {
    if (typeof value !== "object" || value === null) {
        return false;
    }
    const color = value as Partial<Record<keyof CustomColorDefinition, unknown>>;
    return typeof color.h === "number" && Number.isFinite(color.h) && color.h >= 0 && color.h < 360 &&
        isCustomColorComponent(color.s) && isCustomColorComponent(color.l);
}

function isCustomColorScheme(value: unknown): value is CustomColorScheme {
    if (typeof value !== "object" || value === null) {
        return false;
    }
    const scheme = value as Record<string, unknown>;
    if (!isCustomColorDefinition(scheme.defaultColor)) {
        return false;
    }
    return Object.entries(scheme).every(([laneName, lane]) => {
        if (laneName === "defaultColor") {
            return true;
        }
        return typeof lane === "object" && lane !== null &&
            Object.values(lane).every(isCustomColorDefinition);
    });
}

function parseTraceNavigatorSettings(value: unknown): Readonly<TraceNavigatorSettings> {
    if (typeof value !== "object" || value === null) {
        return DEFAULT_TRACE_NAVIGATOR_SETTINGS;
    }
    const settings = value as Partial<Record<keyof TraceNavigatorSettings | "visible", unknown>>;
    const mode = settings.mode;
    const rangeMode = settings.rangeMode;
    return {
        display: settings.display === "expanded" || settings.display === "compact" || settings.display === "hidden"
            ? settings.display
            : settings.visible === true ? "expanded" : DEFAULT_TRACE_NAVIGATOR_SETTINGS.display,
        mode: mode === "top-down" || mode === "fetch" || mode === "issue" ||
            mode === "commit" || mode === "flush" || mode === "latency"
            ? mode
            : DEFAULT_TRACE_NAVIGATOR_SETTINGS.mode,
        rangeMode: rangeMode === "follow" || rangeMode === "overview"
            ? rangeMode
            : DEFAULT_TRACE_NAVIGATOR_SETTINGS.rangeMode,
        height: isPositiveFiniteNumber(settings.height) &&
            settings.height >= MIN_TRACE_NAVIGATOR_HEIGHT
            ? Math.round(settings.height)
            : DEFAULT_TRACE_NAVIGATOR_SETTINGS.height,
        instructionVisible: typeof settings.instructionVisible === "boolean"
            ? settings.instructionVisible
            : DEFAULT_TRACE_NAVIGATOR_SETTINGS.instructionVisible,
        instructionWidth: isPositiveFiniteNumber(settings.instructionWidth) &&
            settings.instructionWidth >= MIN_INSTRUCTION_NAVIGATOR_WIDTH
            ? Math.round(settings.instructionWidth)
            : DEFAULT_TRACE_NAVIGATOR_SETTINGS.instructionWidth,
    };
}

export function parsePersistedViewSettings(value: unknown): PersistedViewSettings | null {
    if (typeof value !== "object" || value === null) {
        return null;
    }
    const settings = value as Partial<Record<keyof PersistedViewSettings, unknown>> & Record<string, unknown>;
    // 旧Web版のthreshold名は読み込みだけ許容し、次回保存時に現在の名称へ移行する。
    const readRenamedSetting = (name: keyof PersistedViewSettings, oldName: string): unknown =>
        settings[name] === undefined ? settings[oldName] : settings[name];
    const textLabelMinimumLaneHeight = readRenamedSetting(
        "textLabelMinimumLaneHeight",
        "drawTextThreshold",
    );
    const stageDetailMinimumLaneHeight = readRenamedSetting(
        "stageDetailMinimumLaneHeight",
        "drawDetailedlyThreshold",
    );
    const dependencyArrowMinimumLaneHeight = readRenamedSetting(
        "dependencyArrowMinimumLaneHeight",
        "drawDependencyThreshold",
    );
    const stageBorderMinimumLaneHeight = readRenamedSetting(
        "stageBorderMinimumLaneHeight",
        "drawFrameThreshold",
    );
    // 既存Web版の保存値にはzoom factorがないため、他の設定を保ったまま現在の既定値を補う。
    const drawZoomFactor = settings.drawZoomFactor === undefined
        ? DEFAULT_PERSISTED_VIEW_SETTINGS.drawZoomFactor
        : settings.drawZoomFactor;
    const webGLEnabled = settings.webGLEnabled === undefined
        ? DEFAULT_PERSISTED_VIEW_SETTINGS.webGLEnabled
        : settings.webGLEnabled;
    const tiledRenderingEnabled = settings.tiledRenderingEnabled === undefined
        ? DEFAULT_PERSISTED_VIEW_SETTINGS.tiledRenderingEnabled
        : settings.tiledRenderingEnabled;
    const textCacheEnabled = settings.textCacheEnabled === undefined
        ? DEFAULT_PERSISTED_VIEW_SETTINGS.textCacheEnabled
        : settings.textCacheEnabled;
    // Autoは現在のDepthと同じ動作だったため、保存済み設定だけを読み替える。
    const colorScheme = settings.colorScheme === "Auto" ? "Depth" : settings.colorScheme;
    if ((settings.theme !== "dark" && settings.theme !== "light") ||
        typeof colorScheme !== "string" ||
        !PIPELINE_COLOR_SCHEMES.has(colorScheme) ||
        !isNonNegativeFiniteNumber(settings.splitterPosition) ||
        (settings.dependencyArrowType !== DEP_ARROW_TYPE.INSIDE_LINE &&
            settings.dependencyArrowType !== DEP_ARROW_TYPE.LEFT_SIDE_CURVE &&
            settings.dependencyArrowType !== DEP_ARROW_TYPE.NOT_SHOW) ||
        !isNonNegativeFiniteNumber(textLabelMinimumLaneHeight) ||
        !isNonNegativeFiniteNumber(stageDetailMinimumLaneHeight) ||
        !isNonNegativeFiniteNumber(dependencyArrowMinimumLaneHeight) ||
        !isNonNegativeFiniteNumber(stageBorderMinimumLaneHeight) ||
        !isPositiveFiniteNumber(drawZoomFactor) ||
        typeof webGLEnabled !== "boolean" ||
        typeof tiledRenderingEnabled !== "boolean" ||
        typeof textCacheEnabled !== "boolean") {
        return null;
    }
    return {
        theme: settings.theme,
        webGLEnabled,
        tiledRenderingEnabled,
        textCacheEnabled,
        traceNavigator: parseTraceNavigatorSettings(settings.traceNavigator),
        colorScheme,
        // 旧Web版の保存値にはこのfieldがないため、他の設定を捨てず既定配色で補う。
        customColorScheme: isCustomColorScheme(settings.customColorScheme)
            ? settings.customColorScheme
            : DEFAULT_CUSTOM_COLOR_SCHEME,
        splitterPosition: settings.splitterPosition,
        dependencyArrowType: settings.dependencyArrowType,
        textLabelMinimumLaneHeight,
        stageDetailMinimumLaneHeight,
        dependencyArrowMinimumLaneHeight,
        stageBorderMinimumLaneHeight,
        drawZoomFactor,
    };
}
