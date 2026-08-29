/** Fetch／Issue／Commit／Flush／Latencyのcycle別系列を保持・集計する。 */

export type CycleActivityMode = "fetch" | "issue" | "commit" | "flush" | "latency";

export interface CycleSeries {
    readonly values: Uint8Array;
    readonly flushedValues?: Uint8Array;
    maximum: number;
}

export interface CycleActivity {
    readonly fetch: CycleSeries;
    readonly issue: CycleSeries;
    readonly commit: CycleSeries;
    readonly flush: CycleSeries;
    readonly latency: CycleSeries;
}

export interface CycleActivitySample {
    readonly startCycle: number;
    readonly endCycle: number;
    readonly average: number;
    readonly maximum: number;
    readonly flushedAverage: number;
    readonly samplingStride: number;
}

export interface CycleSampleRange {
    readonly firstCycle: number;
    readonly lastCycle: number;
    readonly firstSampleCycle: number;
    readonly samplingStride: number;
}

function createSeries(cycleCount: number, withFlushed = false): CycleSeries {
    return {
        values: new Uint8Array(cycleCount),
        flushedValues: withFlushed ? new Uint8Array(cycleCount) : undefined,
        maximum: 0,
    };
}

export function createCycleActivity(cycleCount: number): CycleActivity {
    return {
        fetch: createSeries(cycleCount, true),
        issue: createSeries(cycleCount, true),
        commit: createSeries(cycleCount),
        flush: createSeries(cycleCount),
        latency: createSeries(cycleCount),
    };
}

function incrementValues(values: Uint8Array, cycle: number): number {
    const index = Math.floor(cycle);
    if (!Number.isFinite(index) || index < 0 || index >= values.length) {
        return 0;
    }
    const value = Math.min(255, values[index] + 1);
    values[index] = value;
    return value;
}

export function incrementCycleActivity(
    activity: CycleActivity,
    mode: CycleActivityMode,
    cycle: number,
    flushed = false,
): void {
    const series = activity[mode];
    series.maximum = Math.max(series.maximum, incrementValues(series.values, cycle));
    if (flushed && series.flushedValues !== undefined) {
        incrementValues(series.flushedValues, cycle);
    }
}

export function setCycleLatency(
    activity: CycleActivity,
    cycle: number,
    value: number,
): void {
    const series = activity.latency;
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
        let flushedValues: Uint8Array | undefined;
        if (source.flushedValues !== undefined) {
            flushedValues = new Uint8Array(capacity);
            flushedValues.set(source.flushedValues);
        }
        return { values, flushedValues, maximum: source.maximum };
    };
    return {
        fetch: grow(activity.fetch),
        issue: grow(activity.issue),
        commit: grow(activity.commit),
        flush: grow(activity.flush),
        latency: grow(activity.latency),
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
    let sum = 0;
    let flushedSum = 0;
    const sampledCycleCount = Math.ceil(
        (range.lastCycle - range.firstSampleCycle) / range.samplingStride,
    );
    for (let cycle = range.firstSampleCycle;
        cycle < range.lastCycle;
        cycle += range.samplingStride) {
        sum += series.values[cycle];
        flushedSum += series.flushedValues?.[cycle] ?? 0;
    }
    return {
        startCycle: range.firstCycle,
        endCycle: range.lastCycle,
        average: sum / sampledCycleCount,
        maximum: series.maximum,
        flushedAverage: flushedSum / sampledCycleCount,
        samplingStride: range.samplingStride,
    };
}
