import { Zstd } from "@hpcc-js/wasm-zstd";

export type ProgressCallback = (progress: number) => void;

let zstdStreamTail = Promise.resolve();

async function acquireZstdStream(): Promise<() => void> {
    // Zstd.load()はsingletonなので、複数Tabのstream状態が混ざらないよう読込み単位で直列化する。
    const previous = zstdStreamTail;
    let release: () => void = () => undefined;
    zstdStreamTail = new Promise<void>((resolve) => {
        release = resolve;
    });
    await previous;
    return release;
}

function createZstdDecompressionStream(zstd: Zstd): TransformStream<Uint8Array, Uint8Array> {
    zstd.resetDecompression();
    return new TransformStream<Uint8Array, Uint8Array>({
        transform: (chunk, controller) => {
            const decompressed = zstd.decompressChunk(chunk);
            if (decompressed.length > 0) {
                controller.enqueue(decompressed);
            }
        },
        flush: () => zstd.decompressEnd(),
    });
}

function yieldToBrowser(): Promise<void> {
    // MessageChannelなら連続するsetTimeout(0)の最小待ち時間なしで、描画と入力へ制御を返せる。
    return new Promise<void>((resolve) => {
        const channel = new MessageChannel();
        channel.port1.onmessage = () => {
            channel.port1.close();
            channel.port2.close();
            resolve();
        };
        channel.port2.postMessage(undefined);
    });
}

export class FileLineReader {
    private reader_: ReadableStreamDefaultReader<Uint8Array> | null = null;
    private bytesRead_ = 0;
    private canceled_ = false;

    constructor(readonly file: File) {}

    get progress(): number {
        if (this.file.size === 0) {
            return 1;
        }
        return Math.min(1, this.bytesRead_ / this.file.size);
    }

    get canceled(): boolean {
        return this.canceled_;
    }

    async *lines(onProgress?: ProgressCallback, signal?: AbortSignal): AsyncGenerator<string> {
        if (signal?.aborted) {
            this.canceled_ = true;
            return;
        }

        // 旧版のFileReader.close()と同様に、Tabの寿命が終わったら入力streamも止める。
        const handleAbort = () => {
            void this.cancel().catch(() => undefined);
        };
        signal?.addEventListener("abort", handleAbort, { once: true });

        const countedStream = this.file.stream().pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
            transform: (chunk, controller) => {
                // gzip/zstdでも圧縮前のFileサイズを基準に進捗を表示するため、展開前に数える。
                this.bytesRead_ += chunk.byteLength;
                controller.enqueue(chunk);
            },
        }));

        let inputStream: ReadableStream<Uint8Array> = countedStream;
        let releaseZstdStream: (() => void) | null = null;
        if (/\.gz$/i.test(this.file.name) || this.file.type === "application/gzip") {
            if (typeof DecompressionStream === "undefined") {
                throw new Error("This browser does not support streaming gzip decompression.");
            }
            // TypeScript 6のDOM型ではBufferSourceとUint8Arrayのbuffer型が一致しないが、
            // Web API上はFile.stream()のUint8Arrayをそのままgzip展開器へ渡せる。
            const decompressor = new DecompressionStream("gzip") as unknown as TransformStream<
                Uint8Array,
                Uint8Array
            >;
            inputStream = countedStream.pipeThrough(decompressor);
        }
        else if (/\.zst(?:d)?$/i.test(this.file.name) || this.file.type === "application/zstd") {
            const zstd = await Zstd.load();
            releaseZstdStream = await acquireZstdStream();
            if (this.canceled_) {
                releaseZstdStream();
                signal?.removeEventListener("abort", handleAbort);
                return;
            }
            try {
                inputStream = countedStream.pipeThrough(createZstdDecompressionStream(zstd));
            }
            catch (error) {
                releaseZstdStream();
                throw error;
            }
        }

        const reader = inputStream.getReader();
        this.reader_ = reader;
        const decoder = new TextDecoder("utf-8");
        let buffer = "";
        let lineCount = 0;
        let reachedEOF = false;

        try {
            while (!this.canceled_) {
                const { done, value } = await reader.read();
                if (done) {
                    reachedEOF = true;
                    buffer += decoder.decode();
                    break;
                }

                buffer += decoder.decode(value, { stream: true });
                let lineStart = 0;
                let newline = buffer.indexOf("\n", lineStart);
                while (newline !== -1) {
                    let line = buffer.slice(lineStart, newline);
                    if (line.endsWith("\r")) {
                        line = line.slice(0, -1);
                    }
                    yield line;
                    lineCount++;
                    lineStart = newline + 1;

                    // 大きい入力でも描画とキャンセル操作へ定期的に制御を戻す。
                    if (lineCount % 8192 === 0) {
                        onProgress?.(this.progress);
                        await yieldToBrowser();
                    }
                    newline = buffer.indexOf("\n", lineStart);
                }
                buffer = buffer.slice(lineStart);
            }

            if (!this.canceled_ && buffer.length > 0) {
                yield buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer;
            }
            if (!this.canceled_) {
                this.bytesRead_ = this.file.size;
                onProgress?.(1);
            }
        }
        finally {
            signal?.removeEventListener("abort", handleAbort);
            if (this.reader_ === reader) {
                this.reader_ = null;
            }
            if (reachedEOF) {
                reader.releaseLock();
            }
            else if (!this.canceled_) {
                // Parser errorでもFileの残りを読み続けないよう、途中終了したstreamを閉じる。
                await reader.cancel().catch(() => undefined);
            }
            releaseZstdStream?.();
        }
    }

    async cancel(): Promise<void> {
        this.canceled_ = true;
        if (this.reader_ !== null) {
            await this.reader_.cancel();
            this.reader_ = null;
        }
    }
}
