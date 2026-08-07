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

No alternative is selected yet. The first prototype should be chosen from measured memory and
latency rather than by directly porting the existing gzip-page implementation.
