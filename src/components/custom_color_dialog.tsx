import {
    DEFAULT_CUSTOM_COLOR_SCHEME,
    type CustomColorComponent,
    type CustomColorDefinition,
    type CustomColorScheme,
} from "../renderer/konata_renderer";

interface CustomColorDialogProps {
    readonly scheme: Readonly<CustomColorScheme>;
    readonly onChange: (scheme: Readonly<CustomColorScheme>) => void;
    readonly onClose: () => void;
}

interface ColorTarget {
    readonly key: string;
    readonly label: string;
    readonly lane?: string;
    readonly stage?: string;
}

// 旧Configが標準で公開していた項目だけを並べ、任意stage編集は必要になるまで増やさない。
const COLOR_TARGETS: readonly ColorTarget[] = [
    { key: "default", label: "Default" },
    { key: "0.F", label: "Lane 0 / F", lane: "0", stage: "F" },
    { key: "0.Rn", label: "Lane 0 / Rn", lane: "0", stage: "Rn" },
    { key: "0.Dc", label: "Lane 0 / Dc", lane: "0", stage: "Dc" },
    { key: "0.Is", label: "Lane 0 / Is", lane: "0", stage: "Is" },
    { key: "0.Cm", label: "Lane 0 / Cm", lane: "0", stage: "Cm" },
    { key: "0.f", label: "Lane 0 / f", lane: "0", stage: "f" },
    { key: "1.stl", label: "Lane 1 / stl", lane: "1", stage: "stl" },
];

function isColorDefinition(
    value: CustomColorDefinition | Readonly<Record<string, CustomColorDefinition>> | undefined,
): value is CustomColorDefinition {
    return value !== undefined && "h" in value && "s" in value && "l" in value;
}

function getDefinition(
    scheme: Readonly<CustomColorScheme>,
    target: ColorTarget,
): CustomColorDefinition {
    if (target.lane === undefined || target.stage === undefined) {
        return scheme.defaultColor;
    }
    const lane = scheme[target.lane];
    if (!isColorDefinition(lane)) {
        const definition = lane?.[target.stage];
        if (definition !== undefined) {
            return definition;
        }
    }
    // 古い保存値で項目が欠けていても、編集画面では旧既定値を表示する。
    const defaultLane = DEFAULT_CUSTOM_COLOR_SCHEME[target.lane];
    return !isColorDefinition(defaultLane) && defaultLane?.[target.stage] !== undefined
        ? defaultLane[target.stage]
        : DEFAULT_CUSTOM_COLOR_SCHEME.defaultColor;
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
    return {
        ...scheme,
        [target.lane]: { ...stages, [target.stage]: definition },
    };
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
export function CustomColorDialog({ scheme, onChange, onClose }: CustomColorDialogProps) {
    const updateDefinition = (
        target: ColorTarget,
        update: (definition: CustomColorDefinition) => CustomColorDefinition,
    ) => onChange(replaceDefinition(scheme, target, update(getDefinition(scheme, target))));

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
            >
                <header>
                    <h2 id="custom-color-dialog-title">Custom Colors</h2>
                    <button type="button" aria-label="Close custom colors" onClick={onClose}>×</button>
                </header>
                <p>Saturation and lightness set to Auto follow the current theme.</p>
                <div className="custom-color-table-container">
                    <table>
                        <thead>
                            <tr>
                                <th>Target</th>
                                <th>Preview</th>
                                <th>Hue</th>
                                <th>Saturation</th>
                                <th>Lightness</th>
                            </tr>
                        </thead>
                        <tbody>
                            {COLOR_TARGETS.map((target) => {
                                const definition = getDefinition(scheme, target);
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
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
                <footer>
                    <button type="button" onClick={() => onChange(DEFAULT_CUSTOM_COLOR_SCHEME)}>
                        Reset to Defaults
                    </button>
                    <button type="button" onClick={onClose}>Close</button>
                </footer>
            </section>
        </div>
    );
}
