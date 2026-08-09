import { useState } from "react";
import { BsX } from "react-icons/bs";

import type { StatsValues } from "../core/stats";

interface StatsDialogProps {
    readonly values: Readonly<StatsValues> | null;
    readonly error: string;
    readonly onClose: () => void;
}

// 旧app_stats_dialogと同じName/Value表と正規表現filterをまとめて所有する。
export function StatsDialog({ values, error, onClose }: StatsDialogProps) {
    const [filterPattern, setFilterPattern] = useState("");
    let filterError = "";
    let rows: Array<[string, number]> = [];
    if (values !== null) {
        try {
            const filter = new RegExp(filterPattern, "i");
            rows = Object.entries(values).filter(([name]) => filter.test(name));
        }
        catch (_error) {
            filterError = "Invalid regular expression.";
        }
    }

    return (
        <div
            className="dialog-backdrop"
            onMouseDown={(event) => {
                if (event.target === event.currentTarget) {
                    onClose();
                }
            }}
        >
            <section className="stats-dialog" role="dialog" aria-modal="true" aria-labelledby="stats-dialog-title">
                <header>
                    <h2 id="stats-dialog-title">Stats</h2>
                    <button type="button" aria-label="Close statistics" title="Close" onClick={onClose}>
                        <BsX aria-hidden="true" />
                    </button>
                </header>
                {error === "" ? (
                    <>
                        <input
                            autoFocus
                            type="text"
                            aria-label="Filter statistics"
                            placeholder="Filter pattern for 'Name' column"
                            value={filterPattern}
                            onChange={(event) => setFilterPattern(event.target.value)}
                        />
                        {filterError !== "" && <p className="stats-error">{filterError}</p>}
                        <div className="stats-table-container">
                            <table>
                                <thead>
                                    <tr><th>Name</th><th>Value</th></tr>
                                </thead>
                                <tbody>
                                    {rows.map(([name, value]) => (
                                        <tr key={name}><td>{name}</td><td>{String(value)}</td></tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </>
                ) : (
                    <p className="stats-error">{error}</p>
                )}
                <footer>
                    <button type="button" onClick={onClose}>OK</button>
                </footer>
            </section>
        </div>
    );
}
