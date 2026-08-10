import {
    type KeyboardEvent,
    type PointerEvent,
    useEffect,
    useRef,
    useState,
} from "react";
import { BsClipboard, BsTrash, BsX } from "react-icons/bs";

export type LogLevel = "info" | "warning" | "error";

export interface LogEntry {
    readonly id: number;
    readonly level: LogLevel;
    readonly message: string;
}

interface ResizeStart {
    readonly pointerID: number;
    readonly y: number;
    readonly height: number;
}

interface LogPaneProps {
    readonly entries: readonly LogEntry[];
    readonly onClear: () => void;
    readonly onClose: () => void;
}

const MINIMUM_HEIGHT = 96;
const INITIAL_HEIGHT = 160;

function maximumHeight(): number {
    return Math.max(MINIMUM_HEIGHT, Math.floor(window.innerHeight * 0.6));
}

function clampHeight(height: number): number {
    return Math.min(Math.max(height, MINIMUM_HEIGHT), maximumHeight());
}

function makeClipboardText(entries: readonly LogEntry[]): string {
    return entries.map((entry) => `[${entry.level.toUpperCase()}] ${entry.message}`).join("\n");
}

// Canvasを覆わず、必要な時だけ画面下部を使う小さなドッキングペーンとして表示する。
export function LogPane({ entries, onClear, onClose }: LogPaneProps) {
    const listRef = useRef<HTMLDivElement>(null);
    const resizeStartRef = useRef<ResizeStart | null>(null);
    const [height, setHeight] = useState(INITIAL_HEIGHT);

    useEffect(() => {
        const list = listRef.current;
        if (list !== null) {
            list.scrollTop = list.scrollHeight;
        }
    }, [entries.length]);

    const resize = (nextHeight: number) => setHeight(clampHeight(nextHeight));
    const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
        if (event.button !== 0) {
            return;
        }
        event.currentTarget.setPointerCapture(event.pointerId);
        resizeStartRef.current = {
            pointerID: event.pointerId,
            y: event.clientY,
            height,
        };
    };
    const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
        const start = resizeStartRef.current;
        if (start?.pointerID === event.pointerId) {
            resize(start.height + start.y - event.clientY);
        }
    };
    const finishResize = (event: PointerEvent<HTMLDivElement>) => {
        if (resizeStartRef.current?.pointerID !== event.pointerId) {
            return;
        }
        resizeStartRef.current = null;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
        }
    };
    const handleResizeKey = (event: KeyboardEvent<HTMLDivElement>) => {
        if (event.key !== "ArrowUp" && event.key !== "ArrowDown") {
            return;
        }
        resize(height + (event.key === "ArrowUp" ? 16 : -16));
        event.preventDefault();
    };
    const copyLogs = () => {
        if (navigator.clipboard !== undefined) {
            void navigator.clipboard.writeText(makeClipboardText(entries)).catch(() => {
                // file://等でclipboardが利用できなくてもログ表示自体は維持する。
            });
        }
    };

    return (
        <section className="log-pane" style={{ height }} aria-label="Application log">
            <div
                className="log-pane-resizer"
                role="separator"
                aria-label="Resize application log"
                aria-orientation="horizontal"
                aria-valuemin={MINIMUM_HEIGHT}
                aria-valuemax={maximumHeight()}
                aria-valuenow={height}
                tabIndex={0}
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={finishResize}
                onPointerCancel={finishResize}
                onKeyDown={handleResizeKey}
            />
            <header>
                <h2>Log</h2>
                <span>{entries.length} messages</span>
                <div className="log-pane-actions">
                    <button
                        className="icon-button"
                        type="button"
                        aria-label="Copy logs"
                        title="Copy logs"
                        disabled={entries.length === 0}
                        onClick={copyLogs}
                    >
                        <BsClipboard aria-hidden="true" />
                    </button>
                    <button
                        className="icon-button"
                        type="button"
                        aria-label="Clear logs"
                        title="Clear logs"
                        disabled={entries.length === 0}
                        onClick={onClear}
                    >
                        <BsTrash aria-hidden="true" />
                    </button>
                    <button
                        className="icon-button"
                        type="button"
                        aria-label="Close application log"
                        title="Close"
                        onClick={onClose}
                    >
                        <BsX aria-hidden="true" />
                    </button>
                </div>
            </header>
            <div ref={listRef} className="log-pane-list" role="log" aria-live="polite">
                {entries.length === 0 ? (
                    <p className="log-pane-empty">No messages yet.</p>
                ) : entries.map((entry) => (
                    <div className={`log-entry log-entry-${entry.level}`} key={entry.id}>
                        <span>{entry.level}</span>
                        <pre>{entry.message}</pre>
                    </div>
                ))}
            </div>
        </section>
    );
}
