import { Zstd } from "@hpcc-js/wasm-zstd";

export type ProgressCallback = (progress: number) => void;
type LineCallback = (line: string) => void;

let zstdStreamTail = Promise.resolve();

// 部分文字列がzstd等の大きな展開chunk全体を保持しないよう、文字列化する単位だけを制限する。
// 入力streamや展開器のchunkは分割せず、UTF-8境界は同じTextDecoderのstream状態で引き継ぐ。
const DECODE_CHUNK_SIZE = 8 * 1024;
// この間隔では進捗通知だけでなく、描画・入力・AbortSignalへ制御を返す。
// 大きくすると読込み中の操作応答が落ち、小さくするとtask切替の負担が増えるため、実測済みの値を維持する。
const YIELD_LINE_INTERVAL = 8192;
// 圧縮入力はReader完了後にもParserの終端処理が残るため、100%はFILE_LOAD_FINISHへ予約する。
const MAX_COMPRESSED_PROGRESS = 0.99;

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
    private inputBytesRead_ = 0;
    private decompressedBytesReceived_ = 0;
    private decompressedBytesProcessed_ = 0;
    private reportedProgress_ = 0;
    private canceled_ = false;
    private readonly isCompressed_: boolean;

    constructor(readonly file: File) {
        this.isCompressed_ = /\.(?:gz|zst(?:d)?)$/i.test(file.name) ||
            file.type === "application/gzip" || file.type === "application/zstd";
    }

    get progress(): number {
        if (this.file.size === 0) {
            return 1;
        }
        const inputProgress = Math.min(1, this.inputBytesRead_ / this.file.size);
        if (!this.isCompressed_ || this.decompressedBytesReceived_ === 0) {
            return inputProgress;
        }

        // 展開器へ渡した圧縮入力が先行しても、受取済み展開データのうちParserへ渡し終えた
        // 割合を掛け、展開後chunkの処理待ちを100%到達前の進捗へ反映する。
        const processedRatio = Math.min(
            1,
            this.decompressedBytesProcessed_ / this.decompressedBytesReceived_,
        );
        return inputProgress * processedRatio;
    }

    get canceled(): boolean {
        return this.canceled_;
    }

    async readLines(
        onLine: LineCallback,
        onProgress?: ProgressCallback,
        signal?: AbortSignal,
    ): Promise<void> {
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
                // gzip/zstdでは選択された圧縮済みFileサイズを分母にするため、展開前に数える。
                this.inputBytesRead_ += chunk.byteLength;
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
                this.decompressedBytesReceived_ += value.byteLength;

                for (let offset = 0; offset < value.byteLength; offset += DECODE_CHUNK_SIZE) {
                    const decodeChunk = value.subarray(offset, offset + DECODE_CHUNK_SIZE);
                    buffer += decoder.decode(decodeChunk, { stream: true });
                    let lineStart = 0;
                    let newline = buffer.indexOf("\n", lineStart);
                    while (newline !== -1 && !this.canceled_) {
                        let line = buffer.slice(lineStart, newline);
                        if (line.endsWith("\r")) {
                            line = line.slice(0, -1);
                        }

                        // ここは意図的に同期callbackとして呼ぶ。async generatorで1行ずつyieldすると、
                        // consumer側のfor-awaitを含めて行ごとに複数の短命Promiseが作られる。数百万行の
                        // traceではこれがminor GCを頻発させるため、非同期境界はstreamのchunk取得と
                        // 下記の定期yieldだけに限定する。onLine側もasyncにせず、その場でparseを終えること。
                        onLine(line);
                        lineCount++;
                        lineStart = newline + 1;

                        if (lineCount % YIELD_LINE_INTERVAL === 0) {
                            // awaitをまたぐ前に処理済みの接頭部分を外す。大きなbufferを保持したまま
                            // browserへ制御を返さず、8 KiB decodeによるbacking string制限も維持する。
                            buffer = buffer.slice(lineStart);
                            lineStart = 0;
                            this.notifyProgress_(onProgress);
                            await yieldToBrowser();
                        }
                        newline = buffer.indexOf("\n", lineStart);
                    }
                    buffer = buffer.slice(lineStart);
                    this.decompressedBytesProcessed_ += decodeChunk.byteLength;
                    if (this.canceled_) {
                        break;
                    }
                }
            }

            if (!this.canceled_ && buffer.length > 0) {
                // EOF直前に改行がなくても、従来どおり最後の1行としてParserへ渡す。
                onLine(buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer);
            }
            if (!this.canceled_) {
                this.inputBytesRead_ = this.file.size;
                this.notifyProgress_(onProgress);
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

    private notifyProgress_(onProgress?: ProgressCallback): void {
        const progress = Math.min(
            this.isCompressed_ ? MAX_COMPRESSED_PROGRESS : 1,
            this.progress,
        );
        this.reportedProgress_ = Math.max(this.reportedProgress_, progress);
        onProgress?.(this.reportedProgress_);
    }
}
