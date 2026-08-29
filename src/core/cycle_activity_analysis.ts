/** Fetch／Issue／Commit／Flush／Latencyのcycle別系列を保持・集計する。 */

export type CycleActivityMode = "fetch" | "issue" | "commit" | "flush" | "latency";

export interface CycleSeries {
    readonly values: Uint8Array;
    maximum: number;
}

export interface CycleActivity {
    readonly fetch: CycleSeries;
    readonly issue: CycleSeries;
    readonly commit: CycleSeries;
    readonly flush: CycleSeries;
    readonly latency: CycleSeries;
    readonly flushed: {
        readonly fetch: CycleSeries;
        readonly issue: CycleSeries;
    };
}

export interface CycleActivitySample {
    readonly mode: CycleActivityMode;
    readonly startCycle: number;
    readonly endCycle: number;
    readonly average: number;
    readonly peak: number;
    readonly maximum: number;
    readonly flushedAverage: number;
    readonly sampledCycleCount: number;
    readonly samplingStride: number;
}

export interface CycleSampleRange {
    readonly firstCycle: number;
    readonly lastCycle: number;
    readonly firstSampleCycle: number;
    readonly samplingStride: number;
}

function createSeries(cycleCount: number): CycleSeries {
    return { values: new Uint8Array(cycleCount), maximum: 0 };
}

export function createCycleActivity(cycleCount: number): CycleActivity {
    return {
        fetch: createSeries(cycleCount),
        issue: createSeries(cycleCount),
        commit: createSeries(cycleCount),
        flush: createSeries(cycleCount),
        latency: createSeries(cycleCount),
        flushed: {
            fetch: createSeries(cycleCount),
            issue: createSeries(cycleCount),
        },
    };
}

export function incrementCycle(series: CycleSeries, cycle: number): void {
    const index = Math.floor(cycle);
    if (!Number.isFinite(index) || index < 0 || index >= series.values.length) {
        return;
    }
    const value = Math.min(255, series.values[index] + 1);
    series.values[index] = value;
    series.maximum = Math.max(series.maximum, value);
}

export function setCycleMaximum(series: CycleSeries, cycle: number, value: number): void {
    const index = Math.floor(cycle);
    if (!Number.isFinite(index) || index < 0 || index >= series.values.length) {
        return;
    }
    const bounded = Math.min(255, Math.max(0, Math.ceil(value)));
    series.values[index] = Math.max(series.values[index], bounded);
    series.maximum = Math.max(series.maximum, series.values[index]);
}

export function growCycleActivity(
    activity: Readonly<CycleActivity>,
    capacity: number,
): CycleActivity {
    const grow = (source: Readonly<CycleSeries>): CycleSeries => {
        const values = new Uint8Array(capacity);
        values.set(source.values);
        return { values, maximum: source.maximum };
    };
    return {
        ...activity,
        fetch: grow(activity.fetch),
        issue: grow(activity.issue),
        commit: grow(activity.commit),
        flush: grow(activity.flush),
        latency: grow(activity.latency),
        flushed: {
            fetch: grow(activity.flushed.fetch),
            issue: grow(activity.flushed.issue),
        },
    };
}

export function getCycleSampleRange(
    cycleCount: number,
    startCycle: number,
    endCycle: number,
    maxSampleCycles: number,
): CycleSampleRange | null {
    if (endCycle <= startCycle) {
        return null;
    }
    const firstCycle = Math.max(0, Math.min(cycleCount, Math.floor(startCycle)));
    const lastCycle = Math.max(firstCycle, Math.min(cycleCount, Math.ceil(endCycle)));
    const rangeCycleCount = lastCycle - firstCycle;
    if (rangeCycleCount === 0) {
        return null;
    }
    const sampleLimit = Number.isFinite(maxSampleCycles)
        ? Math.max(1, Math.floor(maxSampleCycles))
        : rangeCycleCount;
    const samplingStride = 2 ** Math.ceil(Math.log2(Math.max(
        1,
        Math.ceil(rangeCycleCount / sampleLimit),
    )));
    const alignedCycle = samplingStride === 1
        ? firstCycle
        : Math.ceil(firstCycle / samplingStride) * samplingStride;
    return {
        firstCycle,
        lastCycle,
        firstSampleCycle: alignedCycle < lastCycle ? alignedCycle : firstCycle,
        samplingStride,
    };
}

export function getCycleActivity(
    activity: Readonly<CycleActivity>,
    cycleCount: number,
    mode: CycleActivityMode,
    startCycle: number,
    endCycle: number,
    maxSampleCycles = Number.POSITIVE_INFINITY,
): CycleActivitySample | null {
    const range = getCycleSampleRange(cycleCount, startCycle, endCycle, maxSampleCycles);
    if (range === null) {
        return null;
    }
    const series = activity[mode];
    const flushedSeries = mode === "fetch"
        ? activity.flushed.fetch
        : mode === "issue"
            ? activity.flushed.issue
            : null;
    let sum = 0;
    let flushedSum = 0;
    let peak = 0;
    let sampledCycleCount = 0;
    for (let cycle = range.firstSampleCycle;
        cycle < range.lastCycle;
        cycle += range.samplingStride) {
        const value = series.values[cycle];
        sum += value;
        flushedSum += flushedSeries?.values[cycle] ?? 0;
        peak = Math.max(peak, value);
        sampledCycleCount++;
    }
    return {
        mode,
        startCycle: range.firstCycle,
        endCycle: range.lastCycle,
        average: sampledCycleCount === 0 ? 0 : sum / sampledCycleCount,
        peak,
        maximum: series.maximum,
        flushedAverage: sampledCycleCount === 0 ? 0 : flushedSum / sampledCycleCount,
        sampledCycleCount,
        samplingStride: range.samplingStride,
    };
}
