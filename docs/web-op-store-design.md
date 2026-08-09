# Web Op Store Design Notes

This document records the measurements and decisions used to replace the Node.js-dependent
`op_list.js`. It is intentionally updated in small steps so that measurements remain separate
from experimental store implementations.

## Stable boundary

The Web core accesses completed operations through the synchronous `OpStore` interface in
`src/core/op_store.ts`. The current `ArrayOpStore` is an uncompressed baseline, not the final
large-trace implementation.

The boundary preserves the following behavior from the existing `OpList`:

- lookup by file-local ID and retired ID;
- synchronous lookup from the Canvas renderer;
- resolution-level ID rounding for zoomed-out rendering;
- explicit write-back after modifying an operation returned by a store;
- explicit resource release when a trace is closed.

## Benchmark method

Run the benchmark through Make in the fixed Node.js 22 Docker environment:

```bash
./docker/launch.sh make benchmark-op-store
./docker/launch.sh make benchmark-op-store BENCHMARK_OPS=200000
```

The default run parses two inputs:

1. `docs/kanata-sample-2.log.gz`, including streaming gzip decompression.
2. A deterministic in-memory trace containing 100,000 operations, one stage per operation.

The input `File` is built before the initial garbage collection. `heapRetainedDelta` therefore
primarily represents parser/model/store allocations rather than input construction. Peak memory
is sampled at the same progress boundaries for every implementation, after parsing, and after
100,000 sequential synchronous lookups. It is not an exact process-wide peak. RSS and
garbage-collection results can vary between runs, so store implementations must be compared in the
same environment and should be run more than once.

This benchmark is deliberately excluded from `make check`. It does not access traces under
`work/`; those larger files require an explicit benchmark decision.

## ArrayOpStore baseline

The baseline was measured twice on 2026-08-08 with Node.js 22.18.0 in the fixed Docker image.
Ranges below contain both runs.

| Input | Size (bytes) | Operations | Parse (ms) | 100k lookups (ms) | Retained heap (MiB) | Sampled peak heap (MiB) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| bundled gzip | 631,214 | 4,041 | 133.44–139.86 | 2.16 | 14.92 | 33.46–33.84 |
| synthetic | 7,811,137 | 100,000 | 347.94–348.42 | 2.92–4.01 | 71.17 | 98.84–99.04 |

After `close()`, heap usage returned to 7.79–7.80 MiB in both runs. This confirms that the
lifecycle releases operations, although RSS remained allocated to the V8 process as expected.

The synthetic baseline retains about 746 bytes per simple one-stage operation. A linear
extrapolation is roughly 712 MiB per million operations before accounting for richer labels,
multiple lanes, dependencies, and temporary parse allocations. The bundled sample uses about
3.8 KiB per operation because its operations are more complex. `ArrayOpStore` is therefore useful
as the small-trace and lookup-latency baseline, but not as the only large-trace store.

The next isolated prototype will serialize completed operations into pages without compression
and retain only a small LRU of decoded pages. This measures the benefit and lookup cost of removing
live object graphs before adding a compression dependency, asynchronous prefetching, or Worker
storage. It is an experiment, not yet the selected production design.

## Pending alternatives

- synchronous browser-compatible page compression;
- asynchronous page decompression hidden by prefetching;
- Worker storage with OPFS or IndexedDB backing;
- retaining the uncompressed store for traces below a measured threshold.

No production alternative is selected yet. Prototypes are chosen from measured memory and latency
rather than by directly porting the existing gzip-page implementation.

## Serialized page experiment

`SerializedPageOpStore` is the first isolated experiment. It uses 256 operations per page, stores
evicted pages as uncompressed JSON strings, and retains four decoded pages in LRU order. Compact
field names and tuple representations reduce repeated JSON keys. All `Op`, lane, stage, dependency,
flag, label, and `lastParsedStage` relationships are restored when a page is decoded.

The comparison was measured twice with the same command and environment as the baseline. “Warm”
repeats 100,000 lookups in the first 256 IDs. “Sequential” performs 100,000 lookups across the
whole ID range and therefore includes page decoding.

| Input and store | Parse (ms) | Warm 100k (ms) | Sequential 100k (ms) | Retained heap (MiB) | Peak after lookup (MiB) |
| --- | ---: | ---: | ---: | ---: | ---: |
| bundled / Array | 127.85–148.24 | 2.07–2.08 | 1.11–1.47 | 14.91 | 35.34–36.08 |
| bundled / Serialized page | 102.93–124.85 | 7.90–8.84 | 362.71–464.00 | 5.75–5.76 | 42.05–81.38 |
| synthetic / Array | 346.93–376.24 | 2.96–3.34 | 1.49–1.54 | 70.03 | 102.38–103.92 |
| synthetic / Serialized page | 401.70–429.08 | 6.59–6.71 | 129.08–133.09 | 19.13–19.14 | 112.49 |

After parsing the synthetic input, 387 serialized pages contained 18,419,459 JSON characters and
four pages remained decoded. After the sequential lookup, all 391 pages had serialized backing
and four remained decoded. The retained heap reduction versus the Array store is approximately
73% for the synthetic input and 61% for the bundled sample.

The experiment validates page serialization as a useful steady-state representation. Warm Canvas
lookups remain fast enough for further testing, but the store is not ready to become the default:

- a full synchronous scan is much slower because every operation is reconstructed;
- temporary decoded objects can make the scan peak higher than the Array baseline;
- synchronous JSON serialization adds parse latency for the synthetic input;
- search and statistics need a page-oriented traversal path instead of repeated `getOp()` calls;
- compression and browser-main-thread responsiveness have not been measured yet.

These measurements show that search and statistics may need a page-oriented traversal API with
periodic event-loop yields before a compressed store becomes the product default. The
Canvas-facing `getOp()` API should remain synchronous for decoded visible pages. The following
prototype first restores the legacy interactive hierarchy so that its zstd replacement can be
measured without changing both lookup policy and page representation at once.

## Hierarchical page and operation caches

The next prototype restores the lookup structure used by the existing `BigKeyValueStore` before
changing the page codec. It keeps non-compressed compact JSON pages but adds the five legacy
sampling spans (`1`, `8`, `64`, `512`, and `4096` operations), four decoded pages per span, and a
shared 32,768-operation LRU. Each span uses 256 entries per page. Resolution rounding remains
`2^(resolution + 1)` operations.

An operation is written to every span that divides its ID. A zoomed-out lookup selects the
coarsest matching span after rounding the ID, so sparse samples are adjacent within their page
instead of forcing unrelated level-0 pages to be decoded. A regression test fixes this selection
and verifies both the page LRU and operation LRU independently.

The fixed Node.js 22 environment produced the following ranges over repeated 100,000-operation
runs. The previous single-level serialized result remains in the table above for comparison.

| Input and store | Parse (ms) | Warm 100k (ms) | Sequential 100k (ms) | Retained heap (MiB) | Peak after lookup (MiB) |
| --- | ---: | ---: | ---: | ---: | ---: |
| bundled / Hierarchical serialized | 103.88–116.07 | 8.16–9.13 | 24.83–30.01 | 8.90–8.91 | 37.23–37.51 |
| synthetic / Hierarchical serialized | 421.33–424.13 | 7.73–7.90 | 640.48–650.62 | 21.34 | 134.42–135.35 |

After parsing the synthetic input, 435 serialized pages contained 20,702,224 JSON characters and
14 pages remained decoded. One sequential pass decoded 391 level-0 pages, 49 span-8 pages, and 7
span-64 pages. No page was decoded more than once during the pass. This confirms that the
hierarchy avoids page thrashing, while its geometric duplication raises retained heap only
moderately compared with the single-level prototype.

The 32,768-entry operation LRU improves repeated interactive access and lets the complete bundled
trace remain warm. For a synthetic trace larger than the LRU, however, a full scan retains many
decoded object graphs and increases both lookup time and sampled peak memory. The cache is retained
because it is part of the legacy interactive algorithm; search and statistics should use a
page-oriented path that does not fill the interactive operation cache if real-trace measurements
show the same cost.

The next isolated change will replace each JSON string page with an independent Zstandard frame.
Compact JSON and the cache constants remain unchanged so that compression ratio, decode latency,
and bundle cost can be measured without mixing in a binary schema, dictionary, prefetching, or
cache tuning.

## Zstandard page experiment

The codec experiment uses `@hpcc-js/wasm-zstd` 1.15.0 and compression level 1. WebAssembly is
loaded asynchronously before parsing, while each evicted page is stored as one independent frame.
After initialization, both compression and decompression remain synchronous, preserving the
Canvas-facing `getOp()` interface. The process-wide codec singleton is not unloaded when a trace
closes because another tab may still use it.

The benchmark now reports the full page serialization and reconstruction time, including compact
model conversion and JSON processing. The following ranges are from two repeated runs in the fixed
Node.js 22 environment. The one-time WebAssembly initialization, approximately 25 ms in a separate
diagnostic, is excluded from parse time.

| Input and store | Parse (ms) | Warm 100k (ms) | Sequential 100k (ms) | Retained heap (MiB) | Stored pages after parse |
| --- | ---: | ---: | ---: | ---: | ---: |
| bundled / Hierarchical JSON | 107.10–114.24 | 7.89–8.42 | 26.88–27.32 | 8.91–8.92 | 2,425,137 characters |
| bundled / Hierarchical zstd | 118.40–124.95 | 10.76–11.05 | 27.70–30.52 | 6.92 | 299,005 bytes |
| synthetic / Hierarchical JSON | 415.48–433.67 | 8.02–8.10 | 639.35–654.46 | 22.42 | 20,702,224 characters |
| synthetic / Hierarchical zstd | 450.81–469.34 | 8.14–8.76 | 668.69–680.94 | 2.87 | 1,380,415 bytes |

For the 100,000-operation synthetic trace, zstd reduces the stored page payload by about 93% and
the retained heap by about 87% relative to hierarchical JSON. Its maximum full-page serialization
time was 0.94–1.28 ms and maximum reconstruction time was 2.55–2.71 ms. The bundled trace has more
complex operations; its corresponding maxima were 3.27–3.34 ms and 3.18–3.31 ms. These measured
pauses remain well below one 60 Hz frame, so a deferred compression queue or Worker would add
complexity without addressing an observed problem. They should only be reconsidered if larger,
richer real traces produce materially longer page times.

The experiment therefore selects synchronous, independently compressed zstd pages for the first
product integration. The JSON codec remains available to tests and benchmarks as the comparison
baseline. Search and statistics still need a page-oriented traversal path because their complete
scan cost is dominated by object reconstruction and operation-cache population rather than zstd
itself.

Wiring the selected store into both Parser paths increased the production single HTML from
315,563 bytes to 568,430 bytes, an increase of 252,867 bytes (about 247 KiB) for the embedded
codec. It adds no external runtime file or network request. The browser smoke test passed with
incremental Kanata rendering, cancellation, unsupported-input cleanup, gem5 fallback, search,
statistics, zoomed rendering, multiple tabs, and tab closure all using the zstd store. The legacy
Electron application remains on its separate existing storage path.
