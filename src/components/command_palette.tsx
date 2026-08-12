import { type KeyboardEvent, useEffect, useRef, useState } from "react";

const COMMAND_HINTS: ReadonlyArray<readonly [string, string]> = [
    ["Jump to #line", "j  <#line>"],
    ["Jump to an op with rid", "jr <rid>"],
    ["Find a string ('F3' key finds next)", "f  <string>"],
    ["Load a file", "l"],
];

interface CommandPaletteProps {
    readonly initialCommand: string;
    readonly history: readonly string[];
    readonly onExecute: (command: string) => void;
    readonly onClose: () => void;
}

// 旧app_command_paletteと同じく、入力、ヒント、履歴だけをこのコンポーネントが所有する。
export function CommandPalette({
    initialCommand,
    history,
    onExecute,
    onClose,
}: CommandPaletteProps) {
    const inputRef = useRef<HTMLInputElement>(null);
    const historyIndexRef = useRef(-1);
    const [command, setCommand] = useState(initialCommand);

    useEffect(() => {
        const input = inputRef.current;
        input?.focus();
        input?.setSelectionRange(input.value.length, input.value.length);
    }, []);

    const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
        if (event.key === "Escape") {
            onClose();
            event.preventDefault();
        }
        else if (event.key === "Enter") {
            onExecute(command);
            event.preventDefault();
        }
        else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
            historyIndexRef.current += event.key === "ArrowUp" ? 1 : -1;
            historyIndexRef.current = Math.min(
                history.length - 1,
                Math.max(-1, historyIndexRef.current),
            );
            const historyCommand = historyIndexRef.current === -1
                ? ""
                : history[historyIndexRef.current] ?? "";
            setCommand(historyCommand);
            requestAnimationFrame(() => {
                const input = inputRef.current;
                input?.setSelectionRange(input.value.length, input.value.length);
            });
            event.preventDefault();
        }
    };

    return (
        <section className="command-palette" aria-label="Command palette">
            <input
                ref={inputRef}
                autoFocus
                type="text"
                aria-label="Command"
                value={command}
                onChange={(event) => setCommand(event.target.value)}
                onBlur={onClose}
                onKeyDown={handleKeyDown}
            />
            <div className="command-hints">
                {COMMAND_HINTS.map(([text, syntax]) => (
                    <div className="command-hint" key={syntax}>
                        <span>{text}</span>
                        <code>{syntax}</code>
                    </div>
                ))}
            </div>
        </section>
    );
}
