/// <reference lib="webworker" />

import { Zstd } from "@hpcc-js/wasm-zstd";

type ZstdStreamMode = "compress" | "decompress";
type ZstdWorkerAction = "chunk" | "finish";

interface ZstdWorkerRequest {
    readonly mode: ZstdStreamMode;
    readonly action: ZstdWorkerAction;
    readonly chunk?: ArrayBuffer;
}

interface ZstdWorkerResponse {
    readonly type: "result" | "error";
    readonly chunk?: ArrayBuffer;
    readonly message?: string;
}

const context = globalThis as unknown as DedicatedWorkerGlobalScope;
const workerGlobal = globalThis as { postMessage?: unknown; document?: unknown };

// このファイルはNode.jsの単体テストでは通常のmoduleとしても読み込まれる。
// worker-loaderが生成したDedicated Worker内だけmessage handlerを登録することで、
// テストでは下端の型用default exportだけを安全に利用できるようにする。
if (typeof workerGlobal.postMessage === "function" && workerGlobal.document === undefined) {
    let activeMode: ZstdStreamMode | null = null;

    context.onmessage = async (event: MessageEvent<ZstdWorkerRequest>) => {
        try {
            const request = event.data;
            const zstd = await Zstd.load();
            if (activeMode === null) {
                activeMode = request.mode;
                if (activeMode === "compress") {
                    zstd.resetCompression();
                }
                else {
                    zstd.resetDecompression();
                }
            }
            if (request.mode !== activeMode) {
                throw new Error("The Zstandard stream mode changed while processing data.");
            }

            let output: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
            if (request.action === "chunk") {
                const chunk = new Uint8Array(request.chunk ?? new ArrayBuffer(0));
                output = activeMode === "compress"
                    ? zstd.compressChunk(chunk)
                    : zstd.decompressChunk(chunk);
            }
            else if (activeMode === "compress") {
                output = zstd.compressEnd();
            }
            else {
                zstd.decompressEnd();
            }

            // WASM heapのviewを直接渡さず、返却値が占める範囲だけを独立したbufferとして移譲する。
            let transferable: ArrayBuffer;
            if (output.buffer instanceof ArrayBuffer &&
                output.byteOffset === 0 && output.byteLength === output.buffer.byteLength) {
                transferable = output.buffer;
            }
            else {
                const copy = new Uint8Array(output.byteLength);
                copy.set(output);
                transferable = copy.buffer;
            }
            const response: ZstdWorkerResponse = { type: "result", chunk: transferable };
            context.postMessage(response, [transferable]);
            if (request.action === "finish") {
                context.close();
            }
        }
        catch (error) {
            const response: ZstdWorkerResponse = {
                type: "error",
                message: error instanceof Error ? error.message : String(error),
            };
            context.postMessage(response);
            context.close();
        }
    };
}

// worker-loaderがbrowser bundleではWorker constructorへ置き換える。
// Node.jsの単体テストでは実体を使わず、zstd_stream.tsの同期fallbackを通る。
export default null as unknown as { new (): Worker };
