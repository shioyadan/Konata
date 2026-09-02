/** Fetch／Issue／Commit／Flush／Latencyを確定binと1-cycle tailへ集計する。 */

export type CycleActivityMode = "fetch" | "issue" | "commit" | "flush" | "latency";

export const TRACE_NAVIGATOR_BIN_CYCLE_COUNT = 32;

export interface CycleSeries {
    // 確定済みprefixはbin内合計（latencyだけ最大値）、末尾はcycle別に保持する。
    readonly bins: Uint16Array;
    readonly tailValues: Uint8Array;
    readonly flushedBins?: Uint16Array;
    readonly flushedTailValues?: Uint8Array;
    maximum: number;
}

export interface CycleActivity {
    readonly binCycleCount: number;
    // [0, sealedCycle)はbins、以降はtailValuesのindex 0から始まる。
    readonly sealedCycle: number;
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

function createSeries(tailCapacity: number, withFlushed = false): CycleSeries {
    return {
        bins: new Uint16Array(0),
        tailValues: new Uint8Array(tailCapacity),
        flushedBins: withFlushed ? new Uint16Array(0) : undefined,
        flushedTailValues: withFlushed ? new Uint8Array(tailCapacity) : undefined,
        maximum: 0,
    };
}

export function createCycleActivity(
    cycleCapacity: number,
    binCycleCount = TRACE_NAVIGATOR_BIN_CYCLE_COUNT,
): CycleActivity {
    const width = Math.max(1, Math.floor(binCycleCount));
    const tailCapacity = Math.max(1, Math.ceil(cycleCapacity));
    return {
        binCycleCount: width,
        sealedCycle: 0,
        fetch: createSeries(tailCapacity, true),
        issue: createSeries(tailCapacity, true),
        commit: createSeries(tailCapacity),
        flush: createSeries(tailCapacity),
        latency: createSeries(tailCapacity),
    };
}

function incrementValues(
    values: Uint8Array,
    sealedCycle: number,
    cycle: number,
): number {
    const index = Math.floor(cycle) - sealedCycle;
    if (!Number.isFinite(index) || index < 0 || index >= values.length) {
        return 0;
    }
    const value = Math.min(0xff, values[index] + 1);
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
    series.maximum = Math.max(
        series.maximum,
        incrementValues(series.tailValues, activity.sealedCycle, cycle),
    );
    if (flushed && series.flushedTailValues !== undefined) {
        incrementValues(series.flushedTailValues, activity.sealedCycle, cycle);
    }
}

export function setCycleLatency(
    activity: CycleActivity,
    cycle: number,
    value: number,
): void {
    const series = activity.latency;
    const index = Math.floor(cycle) - activity.sealedCycle;
    if (!Number.isFinite(index) || index < 0 || index >= series.tailValues.length) {
        return;
    }
    const bounded = Math.min(0xff, Math.max(0, Math.ceil(value)));
    series.tailValues[index] = Math.max(series.tailValues[index], bounded);
    series.maximum = Math.max(series.maximum, series.tailValues[index]);
}

export function growCycleActivity(
    activity: Readonly<CycleActivity>,
    cycleCapacity: number,
): CycleActivity {
    const required = Math.max(1, Math.ceil(cycleCapacity) - activity.sealedCycle);
    const current = activity.fetch.tailValues.length;
    if (required <= current) {
        return activity;
    }
    const capacity = Math.max(required, current * 2);
    const grow = (source: Readonly<CycleSeries>): CycleSeries => {
        const tailValues = new Uint8Array(capacity);
        tailValues.set(source.tailValues);
        let flushedTailValues: Uint8Array | undefined;
        if (source.flushedTailValues !== undefined) {
            flushedTailValues = new Uint8Array(capacity);
            flushedTailValues.set(source.flushedTailValues);
        }
        return {
            bins: source.bins,
            tailValues,
            flushedBins: source.flushedBins,
            flushedTailValues,
            maximum: source.maximum,
        };
    };
    return {
        binCycleCount: activity.binCycleCount,
        sealedCycle: activity.sealedCycle,
        fetch: grow(activity.fetch),
        issue: grow(activity.issue),
        commit: grow(activity.commit),
        flush: grow(activity.flush),
        latency: grow(activity.latency),
    };
}

function growBins(values: Uint16Array, required: number): Uint16Array {
    if (values.length >= required) {
        return values;
    }
    const capacity = values.length === 0
        ? required
        : Math.max(required, values.length * 2);
    const grown = new Uint16Array(capacity);
    grown.set(values);
    return grown;
}

function compactTail(values: Uint8Array, cycles: number, capacity: number): Uint8Array {
    const compacted = new Uint8Array(capacity);
    compacted.set(values.subarray(cycles, cycles + capacity));
    return compacted;
}

/** 今後変化しない完成したcycleだけをbinへ移し、exact tailから捨てる。 */
export function sealCycleActivity(
    activity: Readonly<CycleActivity>,
    confirmedCycle: number,
    cycleCount = activity.sealedCycle + activity.fetch.tailValues.length,
): CycleActivity {
    const { binCycleCount, sealedCycle } = activity;
    const tailEnd = sealedCycle + activity.fetch.tailValues.length;
    const nextSealedCycle = Math.floor(
        Math.max(sealedCycle, Math.min(tailEnd, confirmedCycle)) / binCycleCount,
    ) * binCycleCount;
    if (nextSealedCycle <= sealedCycle) {
        return activity;
    }
    const sealedBinCount = nextSealedCycle / binCycleCount;
    const firstBin = sealedCycle / binCycleCount;
    const sealedTailCycles = nextSealedCycle - sealedCycle;
    const tailCapacity = Math.max(1, Math.ceil(cycleCount) - nextSealedCycle);
    const seal = (source: Readonly<CycleSeries>, latency = false): CycleSeries => {
        const bins = growBins(source.bins, sealedBinCount);
        const flushedBins = source.flushedBins === undefined
            ? undefined
            : growBins(source.flushedBins, sealedBinCount);
        for (let bin = firstBin; bin < sealedBinCount; bin++) {
            const first = (bin - firstBin) * binCycleCount;
            const last = first + binCycleCount;
            let value = 0;
            let flushedValue = 0;
            for (let index = first; index < last; index++) {
                value = latency
                    ? Math.max(value, source.tailValues[index])
                    : value + source.tailValues[index];
                flushedValue += source.flushedTailValues?.[index] ?? 0;
            }
            bins[bin] = Math.min(0xffff, value);
            if (flushedBins !== undefined) {
                flushedBins[bin] = Math.min(0xffff, flushedValue);
            }
        }
        const tailValues = compactTail(
            source.tailValues,
            sealedTailCycles,
            tailCapacity,
        );
        const flushedTailValues = source.flushedTailValues === undefined
            ? undefined
            : compactTail(source.flushedTailValues, sealedTailCycles, tailCapacity);
        return {
            bins,
            tailValues,
            flushedBins,
            flushedTailValues,
            maximum: source.maximum,
        };
    };
    return {
        binCycleCount,
        sealedCycle: nextSealedCycle,
        fetch: seal(activity.fetch),
        issue: seal(activity.issue),
        commit: seal(activity.commit),
        flush: seal(activity.flush),
        latency: seal(activity.latency, true),
    };
}

export function getCycleActivityByteLength(activity: Readonly<CycleActivity>): number {
    let bytes = 0;
    for (const mode of ["fetch", "issue", "commit", "flush", "latency"] as const) {
        const series = activity[mode];
        bytes += series.bins.byteLength + series.tailValues.byteLength;
        bytes += series.flushedBins?.byteLength ?? 0;
        bytes += series.flushedTailValues?.byteLength ?? 0;
    }
    return bytes;
}

export function getCycleActivity(
    activity: Readonly<CycleActivity>,
    cycleCount: number,
    mode: CycleActivityMode,
    startCycle: number,
    endCycle: number,
    _maxSampleCycles = Number.POSITIVE_INFINITY,
): CycleActivitySample | null {
    if (endCycle <= startCycle) {
        return null;
    }
    const firstCycle = Math.max(0, Math.min(cycleCount, Math.floor(startCycle)));
    const lastCycle = Math.max(firstCycle, Math.min(cycleCount, Math.ceil(endCycle)));
    if (lastCycle === firstCycle) {
        return null;
    }
    const { binCycleCount, sealedCycle } = activity;
    const series = activity[mode];
    let sum = 0;
    let flushedSum = 0;
    let latency = 0;
    const binnedEnd = Math.min(lastCycle, sealedCycle);
    if (firstCycle < binnedEnd) {
        const firstBin = Math.floor(firstCycle / binCycleCount);
        const lastBin = Math.ceil(binnedEnd / binCycleCount);
        for (let bin = firstBin; bin < lastBin; bin++) {
            const binStart = bin * binCycleCount;
            const binEnd = binStart + binCycleCount;
            const overlap = Math.max(0, Math.min(binnedEnd, binEnd) -
                Math.max(firstCycle, binStart));
            if (mode === "latency") {
                latency = Math.max(latency, series.bins[bin]);
            } else {
                const fraction = overlap / binCycleCount;
                sum += series.bins[bin] * fraction;
                flushedSum += (series.flushedBins?.[bin] ?? 0) * fraction;
            }
        }
    }
    const tailStart = Math.max(firstCycle, sealedCycle);
    for (let cycle = tailStart; cycle < lastCycle; cycle++) {
        const index = cycle - sealedCycle;
        if (mode === "latency") {
            latency = Math.max(latency, series.tailValues[index]);
        } else {
            sum += series.tailValues[index];
            flushedSum += series.flushedTailValues?.[index] ?? 0;
        }
    }
    const rangeCycleCount = lastCycle - firstCycle;
    return {
        startCycle: firstCycle,
        endCycle: lastCycle,
        average: mode === "latency" ? latency : sum / rangeCycleCount,
        maximum: series.maximum,
        flushedAverage: mode === "latency" ? 0 : flushedSum / rangeCycleCount,
        samplingStride: firstCycle < sealedCycle ? binCycleCount : 1,
    };
}
