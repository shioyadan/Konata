/**
 * CliResponseを人間向けの通常テキストへ整形する表示層。
 * sessionが決めた時間窓・命令・集計結果を表示し、ラベルの省略と端末制御文字の除去を担う。
 * ログ解析・検索・状態変更は行わず、端末幅にも依存しない。JSON出力では使わない。
 */
import type { CliResponse, CliState } from "./session";

// trace中のラベルを端末制御として実行しない。行表示では改行も空白へ置き換える。
function text(value: string, multiline = false): string {
    return value.replace(/[\x00-\x1f\x7f-\x9f]/g, (character) => multiline && character === "\n" ? "\n" : " ");
}

function status(state: CliState): string[] {
    return [
        `File: ${state.file === null ? "(none)" : text(state.file)}${state.format === null ? "" : ` | format: ${state.format}`}`,
        `Input: ${state.range === null ? "unknown" : `[${state.range.begin}, ${state.range.end})`} | instructions: ${state.instructionCount} | parser warnings: ${state.warningCount}`,
        `Window: [${state.window.begin}, ${state.window.end}) | cycles/column: ${state.cyclesPerColumn} | row offset: ${state.rowOffset}`,
        `Filter: ${state.filters.thread === undefined ? "none" : `thread ${state.filters.thread}`}`,
        ...(state.loading === null ? [] : [
            `Load: ${text(state.loading.file)} | ${state.loading.status} | ${Math.floor(state.loading.progress * 100)}%` +
            (state.loading.error === null ? "" : ` | ${text(state.loading.error.message)}`),
        ]),
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
    else if (result?.kind === "timeline") {
        const state = response.state;
        if (result.matchID !== undefined) lines.push(`Match: ID ${result.matchID}`);
        lines.push(`Window [${state.window.begin}, ${state.window.end}) | ${state.cyclesPerColumn} cycles/column | ${result.totalRows} matching instructions`);
        const prefixes = result.rows.map((row) =>
            `${row.id} t${row.thread ?? "?"} ${row.status === "flushed" ? "[flush]" : row.status === "incomplete" ? "[open]" : "[ret]"} ${clipped(row.label, 30)} ${row.continuesBefore ? "<" : " "}`);
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
    else if (result?.kind === "overview") {
        lines.push(`Instruction overview | ${result.totalInstructions} matching instructions | filter: ${response.state.filters.thread === undefined ? "none" : `thread ${response.state.filters.thread}`}`);
        if (result.axis === null) lines.push("(no matching instructions)");
        else {
            const axis = result.axis;
            lines.push(`Cycle axis: ${axis.begin} -> ${axis.end} | ${axis.cyclesPerColumn} cycles/column`);
            const prefixes = result.rows.map((row) => `${row.firstID}-${row.lastID} (${row.instructionCount}; R${row.retired}/F${row.flushed}/O${row.incomplete})`);
            const width = Math.max(9, ...prefixes.map((prefix) => prefix.length));
            lines.push(`${"ID group".padEnd(width)} ${"lifetime".padEnd(response.state.columns)} Representative: ID thread status fetch -> end (cycles)`);
            result.rows.forEach((row, index) => {
                const op = row.representative;
                lines.push(`${prefixes[index].padEnd(width)} ${row.cells.join("")} ID ${op.id} t${op.thread ?? "?"} ${op.status} ${op.begin} -> ${op.end ?? "unknown"} (${op.duration ?? "unknown"})`);
            });
            lines.push("Middle instruction per ID group; lifetimes are samples, not averages or maxima.",
                ". outside lifetime | * retired | x flushed | ? incomplete through observed input | R/F/O group counts");
        }
    }
    else if (result?.kind === "count") {
        const { scope, condition } = result;
        const range = scope.idRange === null ? "all available instructions" : `ID ${scope.idRange.first}-${scope.idRange.last} (inclusive)`;
        lines.push(`Count instructions | source: ${text(scope.source)} | input: ${scope.complete ? "complete" : "partial"}`,
            `Scope: ${range} | filter: ${scope.thread === null ? "none" : `thread ${scope.thread}`}`,
            `Condition: stage ${text(condition.stage)} duration >= ${condition.minimumDuration} cycles`,
            `Matched: ${result.matchedInstructions} / ${result.totalInstructions} (${result.percentage === null ? "n/a" : result.percentage.toFixed(2) + "%"})`,
            `Unfinished ${text(condition.stage)}: ${result.unfinishedInstructions} instructions (not evaluated as closed intervals)`,
            `Maximum matching duration: ${result.maximumDuration === null ? "n/a" : result.maximumDuration + " cycles"}`);
        if (result.unfinishedInstructions > 0) lines.push("An instruction may have both a matching closed interval and an unfinished interval.");
        if (result.groupBy === "pc") {
            lines.push(`PC groups: ${result.groups.length} / ${result.totalGroups} | count | maximum duration (cycles)`);
            for (const group of result.groups) lines.push(`  ${group.pc ?? "unknown"} | ${group.count} | ${group.maximumDuration}`);
            if (response.truncated) lines.push(`${result.totalGroups - result.groups.length} more PC groups; increase top (maximum 256). Totals include all groups.`);
        }
    }
    else if (result?.kind === "topdown") {
        const { scope, analysis, totals } = result;
        const range = scope.range === null ? "none" : `[${scope.range.begin}, ${scope.range.end})`;
        lines.push(`Top-down-like | source: ${text(scope.source)} | input: ${scope.complete ? "complete" : "partial"}`,
            `Scope: cycles ${range} | model instructions: ${scope.instructionCount} | excluded incomplete: ${scope.excludedIncompleteInstructions}`);
        if (scope.requestedRange !== null) lines.push(`Requested: [${scope.requestedRange.begin}, ${scope.requestedRange.end})`);
        if (!result.available || analysis === null || totals === null) {
            lines.push(`Unavailable [${result.reason?.code}]: ${text(result.reason?.message ?? "Unknown reason")}`);
        }
        else {
            lines.push(`Model: ${result.model} | allocation: ${text(analysis.allocation.lane)}/${analysis.allocation.stages.map((name) => text(name)).join("/")}`,
                `Execution: ${text(analysis.execution.lane)}/${analysis.execution.stages.map((name) => text(name)).join("/")} | transition coverage: ${(analysis.transitionCoverage * 100).toFixed(2)}%`,
                `Normalization: ${totals.cycles} cycles x ${analysis.allocationWidth} observed slots/cycle = ${totals.totalSlots} slots`,
                `Precision: ${analysis.interpolated ? "interpolated boundaries" : "exact counts"} | ${analysis.binCycles}-cycle bins | origin: ${analysis.binOrigin}`,
                "Category             slots       percent");
            for (const [name, share] of [["Retiring", totals.retiring], ["Frontend bound", totals.frontendBound],
                ["Backend bound", totals.backendBound], ["Bad speculation", totals.badSpeculation],
                ["Unresolved", totals.unresolved]] as const) {
                lines.push(`${name.padEnd(20)} ${String(share.slots).padStart(10)} ${share.percentage.toFixed(2).padStart(10)}%`);
            }
            lines.push(`Bad speculation: ${totals.badSpeculation.squashedSlots} squashed slots + ${totals.badSpeculation.recoveryBubbleSlots} inferred recovery-bubble slots`,
                `Recovery model: minimum ${analysis.minimumRecoveryCycles ?? "unknown"} cycles | supporting samples: ${analysis.minimumRecoverySampleCount}`,
                "Observed width is a lower bound on capacity. This is a trace-based model, not a measured CPU diagnosis.");
        }
    }
    else if (result?.kind === "detail") {
        const op = result.instruction;
        lines.push(`ID ${op.id} | GID ${op.gid} | RID ${op.rid ?? "unknown"} | thread ${op.thread ?? "unknown"} | ${op.status}`,
            `Source: ${text(op.source.file)}:${op.source.line}`,
            `Lifetime: ${op.begin} -> ${op.end ?? "unknown"}`,
            `Label: ${text(op.label, true)}`);
        if (op.detail !== "") lines.push(`Details: ${text(op.detail, true)}`);
        if (result.stageFilter !== null) {
            lines.push(`Stage filter: ${text(result.stageFilter)} | ${result.totalStages} matching interval${result.totalStages === 1 ? "" : "s"}`);
            if (result.totalStages === 0) lines.push("No matching stages.");
        }
        for (const stage of result.stages) {
            lines.push(`  lane ${text(stage.lane)} | ${text(stage.name)} | ${stage.begin} -> ${stage.end ?? "unknown"} | duration ${stage.duration ?? "unknown"}`);
            if (stage.label !== "") lines.push(`    ${text(stage.label, true)}`);
        }
        if (result.nextStageOffset !== null) {
            // 引用符・backslash・空白を含む名前も、同じfilterを指定して続きへ進める。
            const stage = result.stageFilter === null ? "" : ` stage ${JSON.stringify(result.stageFilter)}`;
            lines.push(`More stages (${result.totalStages} total); use detail id ${op.id}${stage} ${result.nextStageOffset}.`);
        }
    }
    if (result !== null && result.kind !== "status" && result.kind !== "help" && result.kind !== "quit" &&
        response.state.loading !== null && response.state.loading.status !== "ready") {
        const loading = response.state.loading;
        lines.push(`Load: ${loading.status} (${Math.floor(loading.progress * 100)}%); showing available instructions.`);
    }
    for (const warning of response.warnings) lines.push(`Warning: ${text(warning)}`);
    return lines.join("\n");
}
