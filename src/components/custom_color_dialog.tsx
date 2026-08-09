import {
    type PointerEvent as ReactPointerEvent,
    useRef,
    useState,
} from "react";
import {
    BsArrowCounterclockwise,
    BsPlus,
    BsTrash,
    BsX,
} from "react-icons/bs";

import type { ParsedTrace } from "../core/model";
import {
    DEFAULT_CUSTOM_COLOR_SCHEME,
    type CustomColorComponent,
    type CustomColorDefinition,
    type CustomColorScheme,
} from "../renderer/konata_renderer";

interface CustomColorDialogProps {
    readonly scheme: Readonly<CustomColorScheme>;
    readonly trace: ParsedTrace;
    readonly onChange: (scheme: Readonly<CustomColorScheme>) => void;
    readonly onClose: () => void;
}

interface ColorTarget {
    readonly key: string;
    readonly label: string;
    readonly lane?: string;
    readonly stage?: string;
}

interface DialogOffset {
    readonly x: number;
    readonly y: number;
}

interface DragState {
    readonly pointerID: number;
    readonly startX: number;
    readonly startY: number;
    readonly offset: DialogOffset;
    readonly rect: DOMRect;
    readonly headerHeight: number;
}

const DEFAULT_TARGET: ColorTarget = { key: "default", label: "Default" };

function makeTarget(lane: string, stage: string): ColorTarget {
    return { key: `${lane}\u0000${stage}`, label: `Lane ${lane} / ${stage}`, lane, stage };
}

function isColorDefinition(
    value: CustomColorDefinition | Readonly<Record<string, CustomColorDefinition>> | undefined,
): value is CustomColorDefinition {
    return value !== undefined && "h" in value && "s" in value && "l" in value;
}

function findDefinition(
    scheme: Readonly<CustomColorScheme>,
    target: ColorTarget,
): CustomColorDefinition | undefined {
    if (target.lane === undefined || target.stage === undefined) {
        return scheme.defaultColor;
    }
    const lane = scheme[target.lane];
    return !isColorDefinition(lane) ? lane?.[target.stage] : undefined;
}

function getTraceTargets(trace: ParsedTrace): readonly ColorTarget[] {
    return [...trace.laneNames]
        .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }))
        .flatMap((lane) => trace.stageLevelMap.getStageNames(lane).map((stage) =>
            makeTarget(lane, stage)));
}

function getSchemeTargets(
    scheme: Readonly<CustomColorScheme>,
    traceTargets: readonly ColorTarget[],
): readonly ColorTarget[] {
    const traceOrder = new Map(traceTargets.map((target, index) => [target.key, index]));
    const targets = Object.entries(scheme).flatMap(([laneName, lane]) => {
        if (laneName === "defaultColor" || isColorDefinition(lane)) {
            return [];
        }
        return Object.keys(lane).map((stageName) => makeTarget(laneName, stageName));
    });
    return targets.sort((left, right) => {
        const leftOrder = traceOrder.get(left.key) ?? Number.MAX_SAFE_INTEGER;
        const rightOrder = traceOrder.get(right.key) ?? Number.MAX_SAFE_INTEGER;
        return leftOrder - rightOrder || left.label.localeCompare(right.label, undefined, { numeric: true });
    });
}

function replaceDefinition(
    scheme: Readonly<CustomColorScheme>,
    target: ColorTarget,
    definition: CustomColorDefinition,
): CustomColorScheme {
    if (target.lane === undefined || target.stage === undefined) {
        return { ...scheme, defaultColor: definition };
    }
    const currentLane = scheme[target.lane];
    const stages = !isColorDefinition(currentLane) ? currentLane ?? {} : {};
    return { ...scheme, [target.lane]: { ...stages, [target.stage]: definition } };
}

function removeDefinition(
    scheme: Readonly<CustomColorScheme>,
    target: ColorTarget,
): CustomColorScheme {
    if (target.lane === undefined || target.stage === undefined) {
        return { ...scheme };
    }
    const lane = scheme[target.lane];
    if (isColorDefinition(lane) || lane === undefined) {
        return { ...scheme };
    }
    const stages = { ...lane };
    delete stages[target.stage];
    const next = { ...scheme } as Record<
        string,
        CustomColorDefinition | Readonly<Record<string, CustomColorDefinition>>
    >;
    if (Object.keys(stages).length === 0) {
        delete next[target.lane];
    }
    else {
        next[target.lane] = stages;
    }
    return next as CustomColorScheme;
}

function initialDefinition(
    target: ColorTarget,
    traceTargets: readonly ColorTarget[],
): CustomColorDefinition {
    const legacy = findDefinition(DEFAULT_CUSTOM_COLOR_SCHEME, target);
    if (legacy !== undefined) {
        return legacy;
    }
    const index = Math.max(0, traceTargets.findIndex((candidate) => candidate.key === target.key));
    const hue = Math.round(index * 360 / Math.max(1, traceTargets.length)) % 360;
    return { h: hue, s: "auto", l: "auto" };
}

function makeTraceScheme(traceTargets: readonly ColorTarget[]): CustomColorScheme {
    const lanes: Record<string, Record<string, CustomColorDefinition>> = {};
    for (const target of traceTargets) {
        if (target.lane === undefined || target.stage === undefined) {
            continue;
        }
        (lanes[target.lane] ??= {})[target.stage] = initialDefinition(target, traceTargets);
    }
    return { defaultColor: DEFAULT_CUSTOM_COLOR_SCHEME.defaultColor, ...lanes };
}

interface ComponentEditorProps {
    readonly label: string;
    readonly value: CustomColorComponent;
    readonly onChange: (value: CustomColorComponent) => void;
}

function ComponentEditor({ label, value, onChange }: ComponentEditorProps) {
    const automatic = value === "auto";
    return (
        <div className="custom-color-component">
            <label>
                <input
                    type="checkbox"
                    aria-label={`Use automatic ${label}`}
                    checked={automatic}
                    onChange={(event) => onChange(event.target.checked ? "auto" : 50)}
                />
                Auto
            </label>
            <input
                type="number"
                min="0"
                max="100"
                step="1"
                aria-label={label}
                disabled={automatic}
                value={automatic ? "" : value}
                onChange={(event) => {
                    const next = Number(event.target.value);
                    if (Number.isFinite(next)) {
                        onChange(Math.max(0, Math.min(100, Math.round(next))));
                    }
                }}
            />
        </div>
    );
}

// Custom配色だけを既存View panelから切り離し、Canvasを見ながら即時編集できるようにする。
export function CustomColorDialog({ scheme, trace, onChange, onClose }: CustomColorDialogProps) {
    const [selectedStageKey, setSelectedStageKey] = useState("");
    const [offset, setOffset] = useState<DialogOffset>({ x: 0, y: 0 });
    const dragRef = useRef<DragState | null>(null);
    const traceTargets = getTraceTargets(trace);
    const targets = [DEFAULT_TARGET, ...getSchemeTargets(scheme, traceTargets)];
    const missingTargets = traceTargets.filter((target) => findDefinition(scheme, target) === undefined);
    const selectedTarget = missingTargets.find((target) => target.key === selectedStageKey) ?? missingTargets[0];

    const updateDefinition = (
        target: ColorTarget,
        update: (definition: CustomColorDefinition) => CustomColorDefinition,
    ) => {
        const definition = findDefinition(scheme, target);
        if (definition !== undefined) {
            onChange(replaceDefinition(scheme, target, update(definition)));
        }
    };

    const startDrag = (event: ReactPointerEvent<HTMLElement>) => {
        if (event.button !== 0 || (event.target as Element).closest("button") !== null) {
            return;
        }
        const dialog = event.currentTarget.parentElement;
        if (dialog === null) {
            return;
        }
        event.currentTarget.setPointerCapture(event.pointerId);
        dragRef.current = {
            pointerID: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            offset,
            rect: dialog.getBoundingClientRect(),
            headerHeight: event.currentTarget.getBoundingClientRect().height,
        };
        event.preventDefault();
    };

    const moveDrag = (event: ReactPointerEvent<HTMLElement>) => {
        const drag = dragRef.current;
        if (drag === null || drag.pointerID !== event.pointerId) {
            return;
        }
        const margin = 16;
        const visibleWidth = 120;
        const clamp = (value: number, minimum: number, maximum: number) =>
            Math.max(minimum, Math.min(maximum, value));
        const differenceX = clamp(
            event.clientX - drag.startX,
            margin + visibleWidth - drag.rect.right,
            window.innerWidth - margin - visibleWidth - drag.rect.left,
        );
        const differenceY = clamp(
            event.clientY - drag.startY,
            margin - drag.rect.top,
            window.innerHeight - margin - drag.headerHeight - drag.rect.top,
        );
        setOffset({ x: drag.offset.x + differenceX, y: drag.offset.y + differenceY });
    };

    const finishDrag = (event: ReactPointerEvent<HTMLElement>) => {
        if (dragRef.current?.pointerID !== event.pointerId) {
            return;
        }
        dragRef.current = null;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
        }
    };

    return (
        <div
            className="dialog-backdrop"
            onMouseDown={(event) => {
                if (event.target === event.currentTarget) {
                    onClose();
                }
            }}
        >
            <section
                className="custom-color-dialog"
                role="dialog"
                aria-modal="true"
                aria-labelledby="custom-color-dialog-title"
                style={{ transform: `translate(${offset.x}px, ${offset.y}px)` }}
            >
                <header
                    onPointerDown={startDrag}
                    onPointerMove={moveDrag}
                    onPointerUp={finishDrag}
                    onPointerCancel={finishDrag}
                >
                    <h2 id="custom-color-dialog-title">Custom Colors</h2>
                    <button type="button" aria-label="Close custom colors" title="Close" onClick={onClose}>
                        <BsX aria-hidden="true" />
                    </button>
                </header>
                <p>Saturation and lightness set to Auto follow the current theme.</p>
                <div className="custom-color-add">
                    <select
                        aria-label="Stage to add"
                        disabled={selectedTarget === undefined}
                        value={selectedTarget?.key ?? ""}
                        onChange={(event) => setSelectedStageKey(event.target.value)}
                    >
                        {missingTargets.length === 0
                            ? <option value="">All trace stages are included</option>
                            : missingTargets.map((target) => (
                                <option key={target.key} value={target.key}>{target.label}</option>
                            ))}
                    </select>
                    <button
                        className="button-with-icon"
                        type="button"
                        disabled={selectedTarget === undefined}
                        onClick={() => {
                            if (selectedTarget !== undefined) {
                                onChange(replaceDefinition(
                                    scheme,
                                    selectedTarget,
                                    initialDefinition(selectedTarget, traceTargets),
                                ));
                                setSelectedStageKey("");
                            }
                        }}
                    >
                        <BsPlus aria-hidden="true" />
                        <span>Add Stage</span>
                    </button>
                </div>
                <div className="custom-color-table-container">
                    <table>
                        <thead>
                            <tr>
                                <th>Target</th>
                                <th>Preview</th>
                                <th>Hue</th>
                                <th>Saturation</th>
                                <th>Lightness</th>
                                <th aria-label="Actions" />
                            </tr>
                        </thead>
                        <tbody>
                            {targets.map((target) => {
                                const definition = findDefinition(scheme, target) ?? scheme.defaultColor;
                                const previewSaturation = definition.s === "auto" ? 60 : definition.s;
                                const previewLightness = definition.l === "auto" ? 50 : definition.l;
                                return (
                                    <tr key={target.key}>
                                        <th scope="row">{target.label}</th>
                                        <td>
                                            <span
                                                className="custom-color-preview"
                                                aria-label={`${target.label} color preview`}
                                                style={{
                                                    backgroundColor: `hsl(${definition.h}, ${previewSaturation}%, ${previewLightness}%)`,
                                                }}
                                            />
                                        </td>
                                        <td>
                                            <div className="custom-color-hue">
                                                <input
                                                    type="range"
                                                    min="0"
                                                    max="359"
                                                    step="1"
                                                    aria-label={`${target.label} hue slider`}
                                                    value={definition.h}
                                                    onChange={(event) => {
                                                        const hue = Number(event.target.value);
                                                        updateDefinition(target, (color) => ({ ...color, h: hue }));
                                                    }}
                                                />
                                                <input
                                                    type="number"
                                                    min="0"
                                                    max="359"
                                                    step="1"
                                                    aria-label={`${target.label} hue`}
                                                    value={definition.h}
                                                    onChange={(event) => {
                                                        const hue = Number(event.target.value);
                                                        if (Number.isFinite(hue)) {
                                                            updateDefinition(target, (color) => ({
                                                                ...color,
                                                                h: Math.max(0, Math.min(359, Math.round(hue))),
                                                            }));
                                                        }
                                                    }}
                                                />
                                            </div>
                                        </td>
                                        <td>
                                            <ComponentEditor
                                                label={`${target.label} saturation`}
                                                value={definition.s}
                                                onChange={(s) => updateDefinition(target, (color) => ({ ...color, s }))}
                                            />
                                        </td>
                                        <td>
                                            <ComponentEditor
                                                label={`${target.label} lightness`}
                                                value={definition.l}
                                                onChange={(l) => updateDefinition(target, (color) => ({ ...color, l }))}
                                            />
                                        </td>
                                        <td>
                                            {target !== DEFAULT_TARGET && (
                                                <button
                                                    className="icon-button danger-icon-button"
                                                    type="button"
                                                    aria-label={`Remove ${target.label}`}
                                                    title={`Remove ${target.label}`}
                                                    onClick={() => onChange(removeDefinition(scheme, target))}
                                                >
                                                    <BsTrash aria-hidden="true" />
                                                </button>
                                            )}
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
                <footer>
                    <button
                        className="button-with-icon"
                        type="button"
                        onClick={() => onChange(makeTraceScheme(traceTargets))}
                    >
                        <BsArrowCounterclockwise aria-hidden="true" />
                        <span>Reset from Trace</span>
                    </button>
                    <button type="button" onClick={onClose}>Close</button>
                </footer>
            </section>
        </div>
    );
}
