const DATABASE_NAME = "konata.fileHistory";
const DATABASE_VERSION = 1;
const STORE_NAME = "recentFiles";
export const MAX_RECENT_FILES = 5;

export interface RecentFileRecord {
    readonly id: string;
    readonly handle: FileSystemFileHandle;
    readonly name: string;
    readonly lastOpenedAt: number;
    readonly lastModified: number;
    readonly size: number;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
        request.addEventListener("success", () => resolve(request.result));
        request.addEventListener("error", () => reject(request.error));
    });
}

function transactionFinished(transaction: IDBTransaction): Promise<void> {
    return new Promise((resolve, reject) => {
        transaction.addEventListener("complete", () => resolve());
        transaction.addEventListener("abort", () => reject(transaction.error));
        transaction.addEventListener("error", () => reject(transaction.error));
    });
}

function openDatabase(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
        request.addEventListener("upgradeneeded", () => {
            if (!request.result.objectStoreNames.contains(STORE_NAME)) {
                request.result.createObjectStore(STORE_NAME, { keyPath: "id" });
            }
        });
        request.addEventListener("success", () => resolve(request.result));
        request.addEventListener("error", () => reject(request.error));
    });
}

function isRecentFileRecord(value: unknown): value is RecentFileRecord {
    if (typeof value !== "object" || value === null) {
        return false;
    }
    const record = value as Partial<RecentFileRecord>;
    return typeof record.id === "string" &&
        typeof record.name === "string" &&
        typeof record.lastOpenedAt === "number" &&
        typeof record.lastModified === "number" &&
        typeof record.size === "number" &&
        typeof record.handle === "object" && record.handle !== null &&
        record.handle.kind === "file" &&
        typeof record.handle.getFile === "function" &&
        typeof record.handle.isSameEntry === "function";
}

export async function loadRecentFiles(): Promise<readonly RecentFileRecord[]> {
    if (!("indexedDB" in globalThis)) {
        return [];
    }
    const database = await openDatabase();
    try {
        const transaction = database.transaction(STORE_NAME, "readonly");
        const finished = transactionFinished(transaction);
        const values = await requestResult(transaction.objectStore(STORE_NAME).getAll());
        await finished;
        return values
            .filter(isRecentFileRecord)
            .sort((left, right) => right.lastOpenedAt - left.lastOpenedAt)
            .slice(0, MAX_RECENT_FILES);
    }
    finally {
        database.close();
    }
}

export async function rememberRecentFile(
    handle: FileSystemFileHandle,
    file: File,
): Promise<readonly RecentFileRecord[]> {
    const previous = await loadRecentFiles();
    let matchingID: string | null = null;
    for (const record of previous) {
        try {
            if (await handle.isSameEntry(record.handle)) {
                matchingID = record.id;
                break;
            }
        }
        catch {
            // 削除・切断された古いhandleは同一判定から除外し、履歴の残りは利用する。
        }
    }

    const record: RecentFileRecord = {
        id: matchingID ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
        handle,
        name: file.name,
        lastOpenedAt: Date.now(),
        lastModified: file.lastModified,
        size: file.size,
    };
    const next = [record, ...previous.filter((item) => item.id !== matchingID)]
        .slice(0, MAX_RECENT_FILES);
    const retainedIDs = new Set(next.map((item) => item.id));
    const database = await openDatabase();
    try {
        const transaction = database.transaction(STORE_NAME, "readwrite");
        const store = transaction.objectStore(STORE_NAME);
        store.put(record);
        for (const item of previous) {
            if (!retainedIDs.has(item.id)) {
                store.delete(item.id);
            }
        }
        await transactionFinished(transaction);
        return next;
    }
    finally {
        database.close();
    }
}

export async function removeRecentFile(id: string): Promise<readonly RecentFileRecord[]> {
    const database = await openDatabase();
    try {
        const transaction = database.transaction(STORE_NAME, "readwrite");
        transaction.objectStore(STORE_NAME).delete(id);
        await transactionFinished(transaction);
    }
    finally {
        database.close();
    }
    return loadRecentFiles();
}
