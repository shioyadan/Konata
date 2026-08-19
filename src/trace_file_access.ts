/**
 * ブラウザのローカルファイル機能を、Appから利用するためのアクセス境界にまとめる。
 * `TraceFileAccess`はファイル内容ではなく、選択済みファイルを再取得できる権限付きの入口である。
 * `read()`は呼ぶたびに最新内容を読める`TraceInput`を返し、`observe()`は同じ入口の外部変更を通知する。
 * picker、権限、persistent handle、Recent保存、FileSystemObserverはこの層で隠蔽し、
 * Tab、UI Store、Reactには依存しない。どのTabへ対応付けるかは呼出側だけが決める。
 * 通常のfile inputやdropは永続的な入口を持たないため、この層を通さず`File`を直接読み込む。
 */

import type { TraceInput } from "./core/file_line_reader";
import { rememberRecentFile, type RecentFileRecord } from "./recent_files";

interface PersistentFileHandle extends FileSystemFileHandle {
    queryPermission?(descriptor?: { readonly mode: "read" }): Promise<PermissionState>;
    requestPermission?(descriptor?: { readonly mode: "read" }): Promise<PermissionState>;
}

interface FileSystemObserverLike {
    observe(handle: FileSystemHandle): Promise<void>;
    disconnect(): void;
}

type FileSystemObserverConstructor = new (
    callback: (records: readonly { readonly type: string }[]) => void,
) => FileSystemObserverLike;

const TRACE_FILE_PICKER_OPTIONS = {
    id: "konata-trace",
    multiple: false,
    types: [{
        description: "Kanata or gem5 trace",
        accept: {
            "text/plain": [".log", ".txt"],
            "application/gzip": [".gz"],
            "application/zstd": [".zst", ".zstd"],
        },
    }],
} as const;
type TraceFilePickerOptions = typeof TRACE_FILE_PICKER_OPTIONS & {
    readonly startIn?: FileSystemFileHandle;
};
const FILE_CHANGE_DEBOUNCE_MS = 500;

export class TraceFilePermissionError extends Error {}

export interface TraceFileAccess {
    readonly name: string;
    read(signal?: AbortSignal): Promise<TraceInput>;
    remember?(file: File): Promise<readonly RecentFileRecord[]>;
    observe(onChanged: () => void): () => void;
}

const MAX_REMOTE_TRACE_FILES = 2;
const REMOTE_TRACE_PATHS = ["trace1", "trace2"] as const;

function isRemoteTraceFileName(fileName: string): boolean {
    // 表示名はpathに使わないが、本来のbasenameに見えない文字列はUIに入れない。
    return fileName.length > 0 && fileName.length <= 255 &&
        !/[\\/\u0000-\u001f\u007f]/.test(fileName);
}

export function getRemoteTraceFileNames(hash: string): readonly string[] {
    // fragmentはHTTP serverへ送られず、元のfilenameをtab表示と圧縮形式判定にだけ使える。
    const fileNames = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash).getAll("name");
    if (fileNames.length === 0 || fileNames.length > MAX_REMOTE_TRACE_FILES ||
        fileNames.some((fileName) => !isRemoteTraceFileName(fileName))) {
        return [];
    }
    return fileNames;
}

class RemoteTraceInput implements TraceInput {
    private size_ = 0;
    private type_ = "application/octet-stream";

    constructor(
        readonly name: string,
        private readonly url_: string,
    ) {}

    get size(): number {
        return this.size_;
    }

    get type(): string {
        return this.type_;
    }

    async stream(signal?: AbortSignal): Promise<ReadableStream<Uint8Array>> {
        const response = await fetch(this.url_, { cache: "no-store", redirect: "error", signal });
        if (!response.ok || response.body === null) {
            await response.body?.cancel().catch(() => undefined);
            throw new Error(`Could not read ${this.name}. HTTP ${response.status}.`);
        }
        const size = Number(response.headers.get("content-length"));
        if (!Number.isSafeInteger(size) || size < 0) {
            await response.body.cancel().catch(() => undefined);
            throw new Error(`Could not determine the size of ${this.name}.`);
        }
        this.size_ = size;
        this.type_ = response.headers.get("content-type") ?? this.type_;
        return response.body;
    }
}

class RemoteTraceFileAccess implements TraceFileAccess {
    private readonly url_: string;

    constructor(readonly name: string, slot: number, pageURL: string) {
        if (!isRemoteTraceFileName(name)) {
            throw new Error("The remote trace name is invalid.");
        }
        const path = REMOTE_TRACE_PATHS[slot - 1];
        if (path === undefined) {
            throw new Error("The remote trace slot is invalid.");
        }
        const page = new URL(pageURL);
        if (page.protocol !== "http:" && page.protocol !== "https:") {
            throw new Error("Remote traces require an HTTP page.");
        }
        // 表示名からURLを組み立てず、HTMLと同じdirectoryの固定slotだけを参照する。
        this.url_ = new URL(path, page).toString();
    }

    async read(): Promise<TraceInput> {
        return new RemoteTraceInput(this.name, this.url_);
    }

    observe(): () => void {
        // Python標準HTTPサーバーには変更通知がないため、更新はReloadで再取得する。
        return () => undefined;
    }
}

class HandleTraceFileAccess implements TraceFileAccess {
    constructor(
        private readonly handle_: PersistentFileHandle,
        readonly name: string,
    ) {}

    async read(): Promise<File> {
        const permission = await this.handle_.queryPermission?.({ mode: "read" }) ?? "granted";
        const granted = permission === "granted" ||
            (permission === "prompt" && this.handle_.requestPermission !== undefined &&
                await this.handle_.requestPermission({ mode: "read" }) === "granted");
        if (!granted) {
            throw new TraceFilePermissionError(`Permission to read ${this.name} was not granted.`);
        }
        return this.handle_.getFile();
    }

    remember(file: File): Promise<readonly RecentFileRecord[]> {
        return rememberRecentFile(this.handle_, file);
    }

    observe(onChanged: () => void): () => void {
        const Observer = (globalThis as typeof globalThis & {
            FileSystemObserver?: FileSystemObserverConstructor;
        }).FileSystemObserver;
        if (Observer === undefined) {
            return () => undefined;
        }

        let timer: number | null = null;
        let active = true;
        const observer = new Observer((records) => {
            if (!active || records.length === 0) {
                return;
            }
            if (timer !== null) {
                globalThis.clearTimeout(timer);
            }
            // 保存処理が複数eventを出しても、書込みが落ち着いてから一度だけ通知する。
            timer = globalThis.setTimeout(() => {
                timer = null;
                if (active) {
                    onChanged();
                }
            }, FILE_CHANGE_DEBOUNCE_MS);
        });
        const stop = () => {
            if (!active) {
                return;
            }
            active = false;
            if (timer !== null) {
                globalThis.clearTimeout(timer);
                timer = null;
            }
            observer.disconnect();
        };
        try {
            void observer.observe(this.handle_).catch(stop);
        }
        catch {
            stop();
        }
        return stop;
    }
}

export function supportsTraceFilePicker(): boolean {
    return typeof (globalThis as typeof globalThis & {
        showOpenFilePicker?: unknown;
    }).showOpenFilePicker === "function";
}

export async function pickTraceFileAccess(
    startIn?: FileSystemFileHandle,
): Promise<TraceFileAccess | null> {
    const showOpenFilePicker = (globalThis as typeof globalThis & {
        showOpenFilePicker: (
            options: TraceFilePickerOptions,
        ) => Promise<readonly FileSystemFileHandle[]>;
    }).showOpenFilePicker;
    // 固定idはbrowserにKonata用の最終directoryを記憶させる。Recentのhandleがあれば
    // startInを優先し、pageを開き直した後も直前のfileの親directoryから開始する。
    const options: TraceFilePickerOptions = startIn === undefined
        ? TRACE_FILE_PICKER_OPTIONS
        : { ...TRACE_FILE_PICKER_OPTIONS, startIn };
    // user activationを維持するため、この関数内では最初の非同期処理としてpickerを呼ぶ。
    const [handle] = await showOpenFilePicker.call(globalThis, options);
    return handle === undefined
        ? null
        : new HandleTraceFileAccess(handle as PersistentFileHandle, handle.name);
}

export function recentTraceFileAccess(record: RecentFileRecord): TraceFileAccess {
    return new HandleTraceFileAccess(record.handle as PersistentFileHandle, record.name);
}

export function remoteTraceFileAccess(fileName: string, slot: number, pageURL: string): TraceFileAccess {
    return new RemoteTraceFileAccess(fileName, slot, pageURL);
}
