import { useEffect, useRef, useState } from "react";
import {
    BsFileText,
    BsGithub,
    BsInfoCircle,
    BsKeyboard,
    BsList,
    BsX,
} from "react-icons/bs";

declare const __KONATA_VERSION__: string;
declare const __KONATA_COMMIT__: string;
declare const __KONATA_COMMIT_DATE__: string;

const REPOSITORY_URL = "https://github.com/shioyadan/Konata";
const LICENSE_URL = `${REPOSITORY_URL}/blob/master/LICENSE.md`;

type ApplicationDialog = "about" | "shortcuts" | null;

const SHORTCUTS: ReadonlyArray<readonly [string, string]> = [
    ["Open trace", "Ctrl/⌘+O"],
    ["Command palette", "F1 · Ctrl/⌘+Shift+P"],
    ["Search", "Ctrl/⌘+F · F3 / Shift+F3"],
    ["Move", "Arrow keys · Page Up / Page Down"],
    ["Zoom", "+ / − · Ctrl/⌘+wheel"],
    ["Go to bookmark", "0–9"],
    ["Set bookmark", "Ctrl/⌘+0–9"],
    ["Switch tab", "Ctrl/⌘+Tab"],
];

interface InformationDialogProps {
    readonly type: Exclude<ApplicationDialog, null>;
    readonly onClose: () => void;
}

function InformationDialog({ type, onClose }: InformationDialogProps) {
    const isAbout = type === "about";
    const title = isAbout ? "About Konata" : "Keyboard Shortcuts";
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
                className={`application-dialog${isAbout ? " about-dialog" : " shortcuts-dialog"}`}
                role="dialog"
                aria-modal="true"
                aria-labelledby="application-dialog-title"
            >
                <header>
                    <h2 id="application-dialog-title">{title}</h2>
                    <button
                        autoFocus
                        type="button"
                        aria-label={`Close ${title.toLowerCase()}`}
                        title="Close"
                        onClick={onClose}
                    >
                        <BsX aria-hidden="true" />
                    </button>
                </header>
                {isAbout ? (
                    <>
                        <div className="about-summary">
                            <strong>Konata</strong>
                            <span>Pipeline visualization tool</span>
                        </div>
                        <dl className="build-details">
                            <div>
                                <dt>Version</dt>
                                <dd>{__KONATA_VERSION__}</dd>
                            </div>
                            <div>
                                <dt>Commit</dt>
                                <dd><code>{__KONATA_COMMIT__}</code></dd>
                            </div>
                            <div>
                                <dt>Date</dt>
                                <dd>{__KONATA_COMMIT_DATE__}</dd>
                            </div>
                        </dl>
                        <nav className="about-links" aria-label="Project links">
                            <a href={REPOSITORY_URL} target="_blank" rel="noreferrer">
                                <BsGithub aria-hidden="true" /> GitHub
                            </a>
                            <a href={LICENSE_URL} target="_blank" rel="noreferrer">
                                <BsFileText aria-hidden="true" /> Licenses
                            </a>
                        </nav>
                    </>
                ) : (
                    <dl className="shortcut-list">
                        {SHORTCUTS.map(([operation, shortcut]) => (
                            <div key={operation}>
                                <dt>{operation}</dt>
                                <dd>{shortcut}</dd>
                            </div>
                        ))}
                    </dl>
                )}
            </section>
        </div>
    );
}

export function ApplicationMenu() {
    const menuRef = useRef<HTMLDetailsElement>(null);
    const [dialog, setDialog] = useState<ApplicationDialog>(null);

    useEffect(() => {
        const handlePointerDown = (event: PointerEvent) => {
            if (!menuRef.current?.contains(event.target as Node)) {
                menuRef.current?.removeAttribute("open");
            }
        };
        const handleKeyDown = (event: KeyboardEvent) => {
            const menuIsOpen = menuRef.current?.open === true;
            if (event.key !== "Escape" || (dialog === null && !menuIsOpen)) {
                return;
            }
            if (dialog !== null) {
                setDialog(null);
            }
            else {
                menuRef.current?.removeAttribute("open");
            }
            event.preventDefault();
            event.stopPropagation();
        };
        document.addEventListener("pointerdown", handlePointerDown);
        document.addEventListener("keydown", handleKeyDown, true);
        return () => {
            document.removeEventListener("pointerdown", handlePointerDown);
            document.removeEventListener("keydown", handleKeyDown, true);
        };
    }, [dialog]);

    const openDialog = (type: Exclude<ApplicationDialog, null>) => {
        menuRef.current?.removeAttribute("open");
        setDialog(type);
    };
    const closeMenu = () => menuRef.current?.removeAttribute("open");

    return (
        <>
            <details ref={menuRef} className="application-menu">
                <summary className="toolbar-action" aria-label="Application menu" title="Application menu">
                    <BsList aria-hidden="true" />
                    <span>Menu</span>
                </summary>
                <div className="application-menu-panel">
                    <button type="button" onClick={() => openDialog("about")}>
                        <BsInfoCircle aria-hidden="true" /> About Konata
                    </button>
                    <button type="button" onClick={() => openDialog("shortcuts")}>
                        <BsKeyboard aria-hidden="true" /> Keyboard shortcuts
                    </button>
                    <a href={REPOSITORY_URL} target="_blank" rel="noreferrer" onClick={closeMenu}>
                        <BsGithub aria-hidden="true" /> GitHub Repository
                    </a>
                    <a href={LICENSE_URL} target="_blank" rel="noreferrer" onClick={closeMenu}>
                        <BsFileText aria-hidden="true" /> License information
                    </a>
                    <small>Version {__KONATA_VERSION__}</small>
                </div>
            </details>
            {dialog !== null && <InformationDialog type={dialog} onClose={() => setDialog(null)} />}
        </>
    );
}
