import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_CUSTOM_COLOR_SCHEME } from "../src/core/konata_renderer";
import { DEFAULT_PERSISTED_VIEW_SETTINGS, DEFAULT_TRACE_NAVIGATOR_SETTINGS } from "../src/store";
import { parsePersistedViewSettings } from "../src/view_settings";

test("View settings retain valid values without persisting tab-local state", () => {
    const settings = {
        ...DEFAULT_PERSISTED_VIEW_SETTINGS,
        theme: "light",
        colorScheme: "Custom",
        webGLEnabled: false,
        tiledRenderingEnabled: false,
        textCacheEnabled: false,
        textLabelMinimumLaneHeight: 3,
        traceNavigator: {
            display: "compact",
            mode: "commit",
            rangeMode: "follow",
            height: 180,
            instructionVisible: false,
            instructionWidth: 80,
        },
    };
    const original = structuredClone(settings);
    assert.deepEqual(parsePersistedViewSettings({...settings, splitLanes: true}), settings);
    assert.deepEqual(settings, original);
});

test("View settings migrate legacy names and fill missing optional settings", () => {
    const legacy: Record<string, unknown> = {
        ...DEFAULT_PERSISTED_VIEW_SETTINGS,
        theme: "light",
        colorScheme: "Auto",
        splitterPosition: 280,
        customColorScheme: {defaultColor: {h: 999, s: "auto", l: "auto"}},
    };
    const renamed = [
        ["textLabelMinimumLaneHeight", "drawTextThreshold", 3],
        ["stageDetailMinimumLaneHeight", "drawDetailedlyThreshold", 1],
        ["dependencyArrowMinimumLaneHeight", "drawDependencyThreshold", 2],
        ["stageBorderMinimumLaneHeight", "drawFrameThreshold", 4],
    ] as const;
    for (const [current, previous, value] of renamed) {
        delete legacy[current];
        legacy[previous] = value;
    }
    for (const key of ["drawZoomFactor", "webGLEnabled", "tiledRenderingEnabled",
        "textCacheEnabled", "traceNavigator"]) {
        delete legacy[key];
    }
    const parsed = parsePersistedViewSettings(legacy);
    assert.deepEqual(parsed, {
        ...DEFAULT_PERSISTED_VIEW_SETTINGS,
        theme: "light",
        colorScheme: "Depth",
        splitterPosition: 280,
        textLabelMinimumLaneHeight: 3,
        stageDetailMinimumLaneHeight: 1,
        dependencyArrowMinimumLaneHeight: 2,
        stageBorderMinimumLaneHeight: 4,
    });
    assert.equal(legacy.colorScheme, "Auto");
    for (const [current, previous] of renamed) {
        const modern = parsePersistedViewSettings({...legacy, [current]: 0});
        assert.ok(modern);
        assert.equal(modern[current], 0);
        assert.equal(previous in modern, false);
    }
});

test("View settings reject invalid required fields", () => {
    for (const value of [null, undefined, false, [], {}, "dark"]) {
        assert.equal(parsePersistedViewSettings(value), null);
    }
    for (const [key, value] of [
        ["theme", "unknown"], ["colorScheme", "unknown"], ["dependencyArrowType", "unknown"],
        ["splitterPosition", -1], ["textLabelMinimumLaneHeight", NaN],
        ["stageDetailMinimumLaneHeight", Infinity], ["dependencyArrowMinimumLaneHeight", -1],
        ["stageBorderMinimumLaneHeight", "4"], ["drawZoomFactor", 0],
        ["webGLEnabled", 1], ["tiledRenderingEnabled", null], ["textCacheEnabled", "false"],
    ] as const) {
        assert.equal(parsePersistedViewSettings({
            ...DEFAULT_PERSISTED_VIEW_SETTINGS, [key]: value,
        }), null, String(key));
    }
});

test("View settings recover malformed optional values without losing valid settings", () => {
    for (const customColorScheme of [
        undefined, null, {}, {defaultColor: {h: 360, s: "auto", l: "auto"}},
        {...DEFAULT_CUSTOM_COLOR_SCHEME, "0": {F: {h: 0, s: 101, l: "auto"}}},
    ]) {
        const parsed = parsePersistedViewSettings({
            ...DEFAULT_PERSISTED_VIEW_SETTINGS, theme: "light", customColorScheme,
        });
        assert.equal(parsed?.theme, "light");
        assert.deepEqual(parsed?.customColorScheme, DEFAULT_CUSTOM_COLOR_SCHEME);
    }
    const parsed = parsePersistedViewSettings({
        ...DEFAULT_PERSISTED_VIEW_SETTINGS,
        traceNavigator: {
            display: "invalid", mode: "invalid", rangeMode: "invalid",
            height: 63, instructionVisible: "false", instructionWidth: 31,
        },
    });
    assert.deepEqual(parsed?.traceNavigator, DEFAULT_TRACE_NAVIGATOR_SETTINGS);
    const legacy = parsePersistedViewSettings({
        ...DEFAULT_PERSISTED_VIEW_SETTINGS,
        traceNavigator: {visible: true, height: 180.4, instructionWidth: 80.6},
    });
    assert.deepEqual(legacy?.traceNavigator, {
        ...DEFAULT_TRACE_NAVIGATOR_SETTINGS, display: "expanded", height: 180, instructionWidth: 81,
    });
});
