import { useLayoutEffect, useRef } from "react";
import { BsX } from "react-icons/bs";
import {
    DEFAULT_INSTRUCTION_LABEL_SETTINGS,
    formatInstructionLabel,
    type InstructionLabelSettings,
} from "../core/konata_renderer";

interface InstructionLabelDialogProps {
    readonly settings: Readonly<InstructionLabelSettings>;
    readonly onChange: (settings: Readonly<InstructionLabelSettings>) => void;
    readonly onClose: () => void;
}

const FIELDS = [
    ["rowNumber", "Row number (ID / RID)"],
    ["serialID", "Serial ID"],
    ["threadID", "Thread ID"],
    ["retireID", "Retire ID"],
    ["labelText", "Label text"],
] as const;
const EXAMPLE = { gid: 100, tid: 1, rid: 30, labelName: "add x1, x2, x3" };

export function InstructionLabelDialog({ settings, onChange, onClose }: InstructionLabelDialogProps) {
    const dialogRef = useRef<HTMLDialogElement>(null);
    useLayoutEffect(() => {
        const dialog = dialogRef.current;
        if (dialog === null) return;
        const previousFocus = document.activeElement;
        // native modalでTabの移動範囲を閉じ、設定中の背面操作を防ぐ。
        dialog.showModal();
        dialog.querySelector("input")?.focus();
        const wheel = (event: WheelEvent) => {
            if (event.ctrlKey || event.metaKey) event.preventDefault();
            event.stopPropagation();
        };
        dialog.addEventListener("wheel", wheel, { passive: false });
        return () => {
            dialog.removeEventListener("wheel", wheel);
            dialog.close();
            if (previousFocus instanceof HTMLElement && previousFocus.isConnected) {
                previousFocus.focus({ preventScroll: true });
            }
        };
    }, []);
    return (
        <dialog
            ref={dialogRef}
            className="application-dialog instruction-label-dialog"
            aria-labelledby="instruction-label-dialog-title"
            onCancel={(event) => { event.preventDefault(); onClose(); }}
            onKeyDown={(event) => event.stopPropagation()}
        >
            <header>
                <h2 id="instruction-label-dialog-title">Instruction labels</h2>
                <button type="button" aria-label="Close instruction labels" onClick={onClose}>
                    <BsX aria-hidden="true" />
                </button>
            </header>
            <fieldset className="instruction-label-fields">
                <legend>Visible fields</legend>
                {FIELDS.map(([key, label]) => (
                    <label key={key} title={key === "rowNumber"
                        ? "Uses Retire ID when flushed operations are hidden; otherwise uses instruction ID."
                        : undefined}>
                        <input
                            type="checkbox"
                            checked={settings[key]}
                            onChange={(event) => onChange({ ...settings, [key]: event.target.checked })}
                        />
                        {label}
                    </label>
                ))}
            </fieldset>
            <div className="instruction-label-preview" aria-label="Label preview" aria-live="polite">
                <span>Preview (example)</span>
                <pre>{formatInstructionLabel(42, EXAMPLE, settings) || "(No label text)"}</pre>
            </div>
            <p>Applies to all tabs and is saved automatically. Tooltips always show full details.</p>
            <footer>
                <button type="button" onClick={() => onChange(DEFAULT_INSTRUCTION_LABEL_SETTINGS)}>
                    Restore defaults
                </button>
                <button type="button" onClick={onClose}>Close</button>
            </footer>
        </dialog>
    );
}
