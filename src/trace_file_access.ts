/**
 * ブラウザのローカルファイル機能を、Appから利用するためのアクセス境界にまとめる。
 * `TraceFileAccess`はファイル内容ではなく、選択済みファイルを再取得できる権限付きの入口である。
 * `read()`は呼ぶたびに最新の`File` snapshotを返し、`observe()`は同じ入口の外部変更を通知する。
 * picker、権限、persistent handle、Recent保存、FileSystemObserverはこの層で隠蔽し、
 * Tab、UI Store、Reactには依存しない。どのTabへ対応付けるかは呼出側だけが決める。
 * 通常のfile inputやdropは永続的な入口を持たないため、この層を通さず`File`を直接読み込む。
 */

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
const FILE_CHANGE_DEBOUNCE_MS = 500;

export class TraceFilePermissionError extends Error {}

export interface TraceFileAccess {
    readonly name: string;
    read(): Promise<File>;
    remember(file: File): Promise<readonly RecentFileRecord[]>;
    observe(onChanged: () => void): () => void;
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

export async function pickTraceFileAccess(): Promise<TraceFileAccess | null> {
    const showOpenFilePicker = (globalThis as typeof globalThis & {
        showOpenFilePicker: (
            options: typeof TRACE_FILE_PICKER_OPTIONS,
        ) => Promise<readonly FileSystemFileHandle[]>;
    }).showOpenFilePicker;
    // user activationを維持するため、この関数内では最初の非同期処理としてpickerを呼ぶ。
    const [handle] = await showOpenFilePicker.call(globalThis, TRACE_FILE_PICKER_OPTIONS);
    return handle === undefined
        ? null
        : new HandleTraceFileAccess(handle as PersistentFileHandle, handle.name);
}

export function recentTraceFileAccess(record: RecentFileRecord): TraceFileAccess {
    return new HandleTraceFileAccess(record.handle as PersistentFileHandle, record.name);
}
