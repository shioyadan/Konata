import { useLayoutEffect, useRef, useState } from "react";

interface PipelineContextMenuProps {
    readonly left: number;
    readonly top: number;
    readonly copyText: string | null;
    readonly onPin: (() => void) | null;
    readonly onClear: (() => void) | null;
    readonly onGoToFetch: (() => void) | null;
    readonly onGoToReference: (() => void) | null;
    readonly onClose: () => void;
}

export function PipelineContextMenu({
    left, top, copyText, onPin, onClear, onGoToFetch, onGoToReference, onClose,
}: PipelineContextMenuProps) {
    const menuRef = useRef<HTMLDivElement>(null);
    const [copyError, setCopyError] = useState(false);
    const commandKey = navigator.platform.toLowerCase().startsWith("mac") ? "⌘" : "Ctrl";

    useLayoutEffect(() => {
        const menu = menuRef.current;
        if (menu === null) return;
        const previousFocus = document.activeElement;
        const buttons = () => [...menu.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
        (buttons()[0] ?? menu).focus({ preventScroll: true });
        const outside = (event: Event) => {
            if (!menu.contains(event.target as Node)) onClose();
        };
        const wheel = (event: WheelEvent) => {
            // menu内のscrollをviewerへ渡さず、修飾wheelのbrowser zoomも抑える。
            if (event.ctrlKey || event.metaKey) event.preventDefault();
            event.stopPropagation();
        };
        const keyDown = (event: KeyboardEvent) => {
            // menu操作をviewerの移動・zoom・基準点解除へも伝播させない。
            event.stopPropagation();
            if (event.key === "Escape" || event.key === "Tab") {
                event.preventDefault();
                onClose();
            }
            else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
                event.preventDefault();
                const items = buttons();
                const current = items.findIndex((item) => item === document.activeElement);
                const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
                    : (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
                items[next]?.focus();
            }
        };
        document.addEventListener("pointerdown", outside, true);
        document.addEventListener("wheel", outside, true);
        document.addEventListener("scroll", outside, true);
        document.addEventListener("keydown", keyDown, true);
        menu.addEventListener("wheel", wheel, { passive: false });
        window.addEventListener("blur", onClose);
        window.addEventListener("resize", onClose);
        return () => {
            document.removeEventListener("pointerdown", outside, true);
            document.removeEventListener("wheel", outside, true);
            document.removeEventListener("scroll", outside, true);
            document.removeEventListener("keydown", keyDown, true);
            menu.removeEventListener("wheel", wheel);
            window.removeEventListener("blur", onClose);
            window.removeEventListener("resize", onClose);
            if ((menu.contains(document.activeElement) || document.activeElement === document.body) &&
                previousFocus instanceof HTMLElement && previousFocus.isConnected) {
                previousFocus.focus({ preventScroll: true });
            }
        };
    }, [onClose]);

    useLayoutEffect(() => {
        const menu = menuRef.current;
        if (menu === null) return;
        menu.style.left = `${Math.max(4, Math.min(left, window.innerWidth - menu.offsetWidth - 4))}px`;
        menu.style.top = `${Math.max(4, Math.min(top, window.innerHeight - menu.offsetHeight - 4))}px`;
    }, [left, top, copyError]);

    const select = (action: (() => void) | null) => {
        if (action === null) return;
        onClose();
        action();
    };
    const copy = async () => {
        if (copyText === null) return;
        try {
            if (navigator.clipboard === undefined) throw new Error("Clipboard unavailable");
            await navigator.clipboard.writeText(copyText);
            if (menuRef.current !== null) onClose();
        }
        catch {
            if (menuRef.current !== null) setCopyError(true);
        }
    };

    return (
        <div
            ref={menuRef}
            className="pipeline-context-menu"
            role="menu"
            aria-label="Pipeline actions"
            tabIndex={-1}
            style={{ left, top }}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
            onContextMenu={(event) => event.preventDefault()}
        >
            <button role="menuitem" type="button" disabled={onPin === null} onClick={() => select(onPin)}>
                Pin reference here <kbd>{commandKey}+click</kbd>
            </button>
            <button role="menuitem" type="button" disabled={onGoToReference === null} onClick={() => select(onGoToReference)}>
                Go to reference
            </button>
            <button role="menuitem" type="button" disabled={onClear === null} onClick={() => select(onClear)}>
                Clear reference <kbd>Esc</kbd>
            </button>
            <hr role="separator" />
            <button role="menuitem" type="button" disabled={copyText === null} onClick={() => void copy()}>
                Copy instruction info
            </button>
            <button role="menuitem" type="button" disabled={onGoToFetch === null} onClick={() => select(onGoToFetch)}>
                Go to fetch
            </button>
            {copyError && <p role="alert">Could not copy. Check your browser’s clipboard permissions.</p>}
        </div>
    );
}
