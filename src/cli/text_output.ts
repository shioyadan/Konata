import type { CliResponse, CliState } from "./session";

// trace中のラベルを端末制御として実行しない。行表示では改行も空白へ置き換える。
function text(value: string, multiline = false): string {
    return value.replace(/[\x00-\x1f\x7f-\x9f]/g, (character) => multiline && character === "\n" ? "\n" : " ");
}

function status(state: CliState): string[] {
    return [
        `File: ${state.file === null ? "(none)" : text(state.file)}`,
        `Input: ${state.range === null ? "unknown" : `[${state.range.begin}, ${state.range.end})`} | instructions: ${state.instructionCount} | parser warnings: ${state.warningCount}`,
        `Window: [${state.window.begin}, ${state.window.end}) | cycles/column: ${state.cyclesPerColumn} | row offset: ${state.rowOffset}`,
        `Filter: ${state.filters.thread === undefined ? "none" : `thread ${state.filters.thread}`} | selected ID: ${state.selectedID ?? "none"}`,
    ];
}

function clipped(value: string, width: number): string {
    const clean = text(value);
    return clean.length <= width ? clean.padEnd(width) : `${clean.slice(0, width - 1)}~`;
}

export function formatCliText(response: CliResponse): string {
    const lines: string[] = [];
    if (!response.ok) lines.push(`Error [${response.error?.code}]: ${text(response.error?.message ?? "Unknown error")}`);
    const result = response.result;
    if (result?.kind === "help") lines.push(...result.commands);
    else if (result?.kind === "status") {
        lines.push(...status(response.state));
        if (result.attributes !== undefined) {
            lines.push(`Available: ${result.attributes.join(", ")}`, "Use show to view the timeline; help lists commands.");
        }
    }
    else if (result?.kind === "selection") {
        lines.push(`Selected ID ${result.id}${result.hiddenByFilter ? " (hidden by filter)" : ""}: ${text(result.label)}`);
    }
    else if (result?.kind === "timeline") {
        const state = response.state;
        lines.push(`Window [${state.window.begin}, ${state.window.end}) | ${state.cyclesPerColumn} cycles/column | ${result.totalRows} matching instructions`);
        const prefixes = result.rows.map((row) =>
            `${row.selected ? ">" : " "} ${row.id} t${row.thread ?? "?"} ${row.status === "flushed" ? "[flush]" : row.status === "incomplete" ? "[open]" : "[ret]"} ${clipped(row.label, 30)} ${row.continuesBefore ? "<" : " "}`);
        const prefixWidth = Math.max(16, ...prefixes.map((prefix) => prefix.length));
        const cellWidth = Math.max(3, Math.min(5, ...result.rows.flatMap((row) => row.cells.map((cell) => text(cell).length + 1))));
        lines.push(`${"cycle".padEnd(prefixWidth + 1)}${state.window.begin} (+${state.cyclesPerColumn} per cell)`);
        result.rows.forEach((row, index) => {
            lines.push(`${prefixes[index].padEnd(prefixWidth)} ${row.cells.map((cell) => clipped(cell, cellWidth)).join("")}${row.continuesAfter ? ">" : ""}`);
        });
        if (result.rows.length === 0) lines.push("(no instructions at this row offset)");
        lines.push(". no stage | * mixed/parallel stages | @ zero-duration event | ? unobserved | < > continuation | ~ clipped text");
        if (response.nextRow !== null) {
            lines.push(`${result.totalRows - response.nextRow} more rows; use show ${response.nextRow}.`);
        }
    }
    else if (result?.kind === "detail") {
        const op = result.instruction;
        lines.push(`ID ${op.id} | GID ${op.gid} | RID ${op.rid ?? "unknown"} | thread ${op.thread ?? "unknown"} | ${op.status}`,
            `Source: ${text(op.source.file)}:${op.source.line}`,
            `Lifetime: ${op.begin} -> ${op.end ?? "unknown"}`,
            `Label: ${text(op.label, true)}`);
        if (op.detail !== "") lines.push(`Details: ${text(op.detail, true)}`);
        for (const stage of result.stages) {
            lines.push(`  lane ${text(stage.lane)} | ${text(stage.name)} | ${stage.begin} -> ${stage.end ?? "unknown"} | duration ${stage.duration ?? "unknown"}`);
            if (stage.label !== "") lines.push(`    ${text(stage.label, true)}`);
        }
        if (result.nextStageOffset !== null) {
            lines.push(`More stages (${result.totalStages} total); use detail ${result.nextStageOffset}.`);
        }
    }
    for (const warning of response.warnings) lines.push(`Warning: ${text(warning)}`);
    return lines.join("\n");
}
