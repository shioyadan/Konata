import { useEffect, useRef, useState } from "react";
import {
    BsFileText,
    BsGithub,
    BsInfoCircle,
    BsJournalText,
    BsKeyboard,
    BsList,
    BsX,
} from "react-icons/bs";

declare const __KONATA_VERSION__: string;
declare const __KONATA_COMMIT__: string;
declare const __KONATA_COMMIT_DATE__: string;
declare const __KONATA_LICENSE__: string;
declare const __KONATA_THIRD_PARTY_LICENSES__: string;

const REPOSITORY_URL = "https://github.com/shioyadan/Konata";

type ApplicationDialog = "about" | "license" | "licenses" | "shortcuts" | null;

interface ApplicationMenuProps {
    readonly unreadLogCount: number;
    readonly hasUnreadWarning: boolean;
    readonly onOpenLog: () => void;
}

function getShortcuts(platform: string): ReadonlyArray<readonly [string, string]> {
    // macOSでは実際のevent.metaKeyに合わせ、それ以外ではCtrlと表記する。
    const commandKey = platform.toLowerCase().startsWith("mac") ? "⌘" : "Ctrl";
    return [
        ["Open trace", `${commandKey}+O`],
        ["Command palette", `F1 · ${commandKey}+Shift+P`],
        ["Search", `${commandKey}+F · F3 / Shift+F3`],
        ["Move", "Arrow keys · Page Up / Page Down"],
        ["Pan canvas", "Drag · wheel · horizontal trackpad"],
        ["Zoom in", `+ · ${commandKey}+↑ · Double-click`],
        ["Zoom out", `− · ${commandKey}+↓ · Shift+double-click`],
        ["Zoom gesture", `${commandKey}+wheel · Pinch`],
        ["Align fetch cycle", "Click instruction label"],
        ["Go to bookmark", "0–9"],
        ["Set bookmark", `${commandKey}+0–9`],
        ["Close tab", "Middle-click tab"],
        ["Close dialog", "Esc"],
    ];
}

interface InformationDialogProps {
    readonly type: Exclude<ApplicationDialog, null>;
    readonly onClose: () => void;
    readonly onOpenLicense: () => void;
    readonly onOpenThirdPartyLicenses: () => void;
}

function InformationDialog({
    type,
    onClose,
    onOpenLicense,
    onOpenThirdPartyLicenses,
}: InformationDialogProps) {
    const isAbout = type === "about";
    const isLicense = type === "license";
    const isLicenses = type === "licenses";
    const title = isAbout
        ? "About Konata"
        : isLicense
            ? "Konata License"
            : isLicenses
                ? "Third-Party Licenses"
                : "Keyboard Shortcuts";
    const shortcuts = getShortcuts(navigator.platform);
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
                className={`application-dialog${
                    isAbout
                        ? " about-dialog"
                        : isLicense || isLicenses
                            ? " licenses-dialog"
                            : " shortcuts-dialog"
                }`}
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
                        <p className="about-authors">Ryota Shioya and Kojiro Izuoka</p>
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
                            <button type="button" onClick={onOpenLicense}>
                                <BsFileText aria-hidden="true" /> License
                            </button>
                            <button type="button" onClick={onOpenThirdPartyLicenses}>
                                <BsJournalText aria-hidden="true" /> Third-party licenses
                            </button>
                        </nav>
                    </>
                ) : isLicense || isLicenses ? (
                    // 正本を加工せず表示し、単一HTML内の通知と配布文書の内容を一致させる。
                    <pre className="third-party-licenses">{
                        isLicense ? __KONATA_LICENSE__ : __KONATA_THIRD_PARTY_LICENSES__
                    }</pre>
                ) : (
                    <dl className="shortcut-list">
                        {shortcuts.map(([operation, shortcut]) => (
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

export function ApplicationMenu({ unreadLogCount, hasUnreadWarning, onOpenLog }: ApplicationMenuProps) {
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
    const openLog = () => {
        menuRef.current?.removeAttribute("open");
        onOpenLog();
    };
    return (
        <>
            <details ref={menuRef} className="application-menu">
                <summary
                    className="toolbar-action"
                    aria-label={hasUnreadWarning
                        ? "Application menu, unread warnings in application log"
                        : "Application menu"}
                    title={hasUnreadWarning
                        ? "Application menu — unread warnings"
                        : "Application menu"}
                >
                    <BsList aria-hidden="true" />
                    <span>Menu</span>
                    {hasUnreadWarning && (
                        <span className="application-menu-warning-badge" aria-hidden="true">!</span>
                    )}
                </summary>
                <div className="application-menu-panel">
                    <button type="button" aria-label="Application log" onClick={openLog}>
                        <BsJournalText aria-hidden="true" /> Application log
                        {unreadLogCount > 0 && (
                            <span
                                className="application-menu-count"
                                aria-label={`${unreadLogCount} unread log messages`}
                            >
                                {unreadLogCount > 99 ? "99+" : unreadLogCount}
                            </span>
                        )}
                    </button>
                    <button type="button" onClick={() => openDialog("shortcuts")}>
                        <BsKeyboard aria-hidden="true" /> Keyboard shortcuts
                    </button>
                    <button type="button" onClick={() => openDialog("about")}>
                        <BsInfoCircle aria-hidden="true" /> About Konata
                    </button>
                    <small>Version {__KONATA_VERSION__}</small>
                </div>
            </details>
            {dialog !== null && (
                <InformationDialog
                    type={dialog}
                    onClose={() => setDialog(null)}
                    onOpenLicense={() => setDialog("license")}
                    onOpenThirdPartyLicenses={() => setDialog("licenses")}
                />
            )}
        </>
    );
}
