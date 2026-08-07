export type ProgressCallback = (progress: number) => void;

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

    async *lines(onProgress?: ProgressCallback): AsyncGenerator<string> {
        const countedStream = this.file.stream().pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
            transform: (chunk, controller) => {
                // gzipでも圧縮前のFileサイズを基準に進捗を表示するため、展開前に数える。
                this.bytesRead_ += chunk.byteLength;
                controller.enqueue(chunk);
            },
        }));

        let inputStream: ReadableStream<Uint8Array> = countedStream;
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

        this.reader_ = inputStream.getReader();
        const decoder = new TextDecoder("utf-8");
        let buffer = "";
        let lineCount = 0;

        while (!this.canceled_) {
            const { done, value } = await this.reader_.read();
            if (done) {
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
                    await new Promise<void>((resolve) => setTimeout(resolve, 0));
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

    async cancel(): Promise<void> {
        this.canceled_ = true;
        if (this.reader_ !== null) {
            await this.reader_.cancel();
            this.reader_ = null;
        }
    }
}
