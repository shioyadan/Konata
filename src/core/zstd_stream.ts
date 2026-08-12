// ZstandardがWeb標準へ追加された際に、利用側を変えず実装だけを交換するための互換層。
// 公開するconstructorとreadable/writableはCompressionStream/DecompressionStreamと
// 同じ形に限定し、WASM固有の圧縮levelやWorker制御は外へ出さない。

import { Zstd } from "@hpcc-js/wasm-zstd";

import ZstdStreamWorker from "./zstd_stream_worker";

type ZstdStreamMode = "compress" | "decompress";
type ZstdWorkerAction = "chunk" | "finish";

interface ZstdWorkerResponse {
    readonly type: "result" | "error";
    readonly chunk?: ArrayBuffer;
    readonly message?: string;
}

interface ZstdStreamBackend {
    transform(chunk: Uint8Array): Promise<Uint8Array>;
    finish(): Promise<Uint8Array>;
    close(reason?: unknown): void;
}

export interface KonataZstdCompressionStream {
    readonly readable: ReadableStream<Uint8Array>;
    readonly writable: WritableStream<Uint8Array>;
}

export interface KonataZstdDecompressionStream {
    readonly readable: ReadableStream<Uint8Array>;
    readonly writable: WritableStream<Uint8Array>;
}

interface KonataZstdCompressionStreamConstructor {
    new (format: "zstd"): KonataZstdCompressionStream;
}

interface KonataZstdDecompressionStreamConstructor {
    new (format: "zstd"): KonataZstdDecompressionStream;
}

let localCompressionTail = Promise.resolve();
let localDecompressionTail = Promise.resolve();

async function acquireLocalZstd(mode: ZstdStreamMode): Promise<() => void> {
    // Node.jsの単体テストにはWeb Workerがないため、従来のsingletonを直列化して使う。
    // browserでは各streamが独立したWorkerを持つので、この待ち合わせは発生しない。
    const previous = mode === "compress" ? localCompressionTail : localDecompressionTail;
    let release: () => void = () => undefined;
    const current = new Promise<void>((resolve) => {
        release = resolve;
    });
    if (mode === "compress") {
        localCompressionTail = current;
    }
    else {
        localDecompressionTail = current;
    }
    await previous;
    return release;
}

class LocalZstdStreamBackend implements ZstdStreamBackend {
    private initialized_: Promise<Zstd> | null = null;
    private release_: (() => void) | null = null;
    private closed_ = false;

    constructor(private readonly mode_: ZstdStreamMode) {}

    async transform(chunk: Uint8Array): Promise<Uint8Array> {
        const zstd = await this.initialize_();
        return this.mode_ === "compress"
            ? zstd.compressChunk(chunk)
            : zstd.decompressChunk(chunk);
    }

    async finish(): Promise<Uint8Array> {
        try {
            const zstd = await this.initialize_();
            if (this.mode_ === "compress") {
                return zstd.compressEnd();
            }
            zstd.decompressEnd();
            return new Uint8Array(0);
        }
        finally {
            this.close();
        }
    }

    close(): void {
        if (this.closed_) {
            return;
        }
        this.closed_ = true;
        this.release_?.();
        this.release_ = null;
    }

    private initialize_(): Promise<Zstd> {
        if (this.initialized_ === null) {
            this.initialized_ = (async () => {
                this.release_ = await acquireLocalZstd(this.mode_);
                if (this.closed_) {
                    this.release_();
                    this.release_ = null;
                    throw new Error("The Zstandard stream was canceled.");
                }
                const zstd = await Zstd.load();
                if (this.mode_ === "compress") {
                    zstd.resetCompression();
                }
                else {
                    zstd.resetDecompression();
                }
                return zstd;
            })();
        }
        return this.initialized_;
    }
}

class WorkerZstdStreamBackend implements ZstdStreamBackend {
    private readonly worker_ = new ZstdStreamWorker();
    private pending_: {
        resolve: (value: Uint8Array) => void;
        reject: (reason: unknown) => void;
    } | null = null;
    private closed_ = false;

    constructor(private readonly mode_: ZstdStreamMode) {
        this.worker_.onmessage = (event: MessageEvent<ZstdWorkerResponse>) => {
            const pending = this.pending_;
            if (pending === null) {
                return;
            }
            this.pending_ = null;
            if (event.data.type === "error") {
                pending.reject(new Error(event.data.message ?? "Zstandard Worker failed."));
                this.close();
                return;
            }
            pending.resolve(new Uint8Array(event.data.chunk ?? new ArrayBuffer(0)));
        };
        this.worker_.onerror = (event) => {
            const error = new Error(event.message || "Zstandard Worker failed.");
            this.pending_?.reject(error);
            this.pending_ = null;
            this.close();
        };
    }

    transform(chunk: Uint8Array): Promise<Uint8Array> {
        // File/ReadableStreamから受け取ったchunkの所有権をWorkerへ移し、巨大入力の複製を避ける。
        // subarrayの場合だけ範囲外のbyteを送らないよう、独立したbufferへ切り詰める。
        const transferable = chunk.byteOffset === 0 && chunk.byteLength === chunk.buffer.byteLength &&
            chunk.buffer instanceof ArrayBuffer
            ? chunk.buffer
            : chunk.slice().buffer;
        return this.request_("chunk", transferable);
    }

    async finish(): Promise<Uint8Array> {
        try {
            return await this.request_("finish");
        }
        finally {
            this.close();
        }
    }

    close(reason: unknown = new Error("The Zstandard stream was canceled.")): void {
        if (this.closed_) {
            return;
        }
        this.closed_ = true;
        this.worker_.terminate();
        this.pending_?.reject(reason);
        this.pending_ = null;
    }

    private request_(action: ZstdWorkerAction, chunk?: ArrayBuffer): Promise<Uint8Array> {
        if (this.closed_) {
            return Promise.reject(new Error("The Zstandard stream is closed."));
        }
        if (this.pending_ !== null) {
            return Promise.reject(new Error("Zstandard Worker requests must not overlap."));
        }
        return new Promise<Uint8Array>((resolve, reject) => {
            this.pending_ = { resolve, reject };
            const message = { mode: this.mode_, action, chunk };
            if (chunk === undefined) {
                this.worker_.postMessage(message);
            }
            else {
                this.worker_.postMessage(message, [chunk]);
            }
        });
    }
}

function createBackend(mode: ZstdStreamMode): ZstdStreamBackend {
    // 製品browserではWorkerへ分離する。Node.jsの単体テストだけは同じWASM処理をmain threadで通す。
    return typeof Worker === "undefined"
        ? new LocalZstdStreamBackend(mode)
        : new WorkerZstdStreamBackend(mode);
}

class WasmKonataZstdStream {
    readonly readable: ReadableStream<Uint8Array>;
    readonly writable: WritableStream<Uint8Array>;

    constructor(format: "zstd", mode: ZstdStreamMode) {
        if (format !== "zstd") {
            throw new TypeError(`Unsupported compression format: ${String(format)}`);
        }

        const backend = createBackend(mode);
        const transform = new TransformStream<Uint8Array, Uint8Array>({
            transform: async (chunk, controller) => {
                try {
                    const output = await backend.transform(chunk);
                    if (output.byteLength > 0) {
                        controller.enqueue(output);
                    }
                }
                catch (error) {
                    backend.close(error);
                    throw error;
                }
            },
            flush: async (controller) => {
                const output = await backend.finish();
                if (output.byteLength > 0) {
                    controller.enqueue(output);
                }
            },
        });
        this.writable = transform.writable;

        // TransformStreamだけではreadable側のcancelをWASM Workerへ通知できないため、薄いreaderを
        // 一枚挟む。chunk単位のPromiseだけで、traceの各行には非同期処理を増やさない。
        const reader = transform.readable.getReader();
        this.readable = new ReadableStream<Uint8Array>({
            pull: async (controller) => {
                try {
                    const result = await reader.read();
                    if (result.done) {
                        controller.close();
                    }
                    else {
                        controller.enqueue(result.value);
                    }
                }
                catch (error) {
                    backend.close(error);
                    controller.error(error);
                }
            },
            cancel: async (reason) => {
                backend.close(reason);
                await reader.cancel(reason).catch(() => undefined);
            },
        });
    }
}

class WasmKonataZstdCompressionStream extends WasmKonataZstdStream {
    constructor(format: "zstd") {
        super(format, "compress");
    }
}

class WasmKonataZstdDecompressionStream extends WasmKonataZstdStream {
    constructor(format: "zstd") {
        super(format, "decompress");
    }
}

// 実装選択は意図的に自動化しない。将来browserのzstd対応を採用するときは、この2行だけを
// CompressionStream/DecompressionStreamのconstructorへ明示的に差し替える。
export const KonataZstdCompressionStream: KonataZstdCompressionStreamConstructor =
    WasmKonataZstdCompressionStream;
export const KonataZstdDecompressionStream: KonataZstdDecompressionStreamConstructor =
    WasmKonataZstdDecompressionStream;
