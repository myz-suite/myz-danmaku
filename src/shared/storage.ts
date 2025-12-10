import type { CachedDanmakuRecord } from "./danmaku";

const LOCAL_CACHE_DB_NAME = "myz-danmaku-cache";
const LOCAL_CACHE_STORE = "danmaku";

let danmakuDbPromise: Promise<IDBDatabase> | null = null;

export function openDanmakuDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") {
    return Promise.reject(new Error("IndexedDB not supported"));
  }
  if (!danmakuDbPromise) {
    danmakuDbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(LOCAL_CACHE_DB_NAME, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(LOCAL_CACHE_STORE)) {
          db.createObjectStore(LOCAL_CACHE_STORE, { keyPath: "videoId" });
        }
      };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => {
          db.close();
          danmakuDbPromise = null;
        };
        resolve(db);
      };
      request.onerror = () => {
        danmakuDbPromise = null;
        reject(request.error ?? new Error("MyZ Danmaku: failed to open IndexedDB"));
      };
      request.onblocked = () => {
        console.warn("MyZ Danmaku: IndexedDB open blocked");
      };
    });
    danmakuDbPromise.catch(() => {
      danmakuDbPromise = null;
    });
  }
  return danmakuDbPromise;
}

export async function writeDanmakuRecord(record: CachedDanmakuRecord): Promise<void> {
  try {
    const db = await openDanmakuDatabase();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(LOCAL_CACHE_STORE, "readwrite");
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("MyZ Danmaku: IndexedDB transaction failed"));
      tx.onabort = () => reject(tx.error ?? new Error("MyZ Danmaku: IndexedDB transaction aborted"));
      const store = tx.objectStore(LOCAL_CACHE_STORE);
      store.put(record);
    });
  } catch (error) {
    console.warn("MyZ Danmaku: failed to persist cache", error);
    throw error;
  }
}

export async function readDanmakuRecord(videoId: string): Promise<CachedDanmakuRecord | null> {
  try {
    const db = await openDanmakuDatabase();
    return await new Promise<CachedDanmakuRecord | null>((resolve, reject) => {
      const tx = db.transaction(LOCAL_CACHE_STORE, "readonly");
      tx.onerror = () => reject(tx.error ?? new Error("MyZ Danmaku: IndexedDB read failed"));
      tx.onabort = () => reject(tx.error ?? new Error("MyZ Danmaku: IndexedDB read aborted"));
      const store = tx.objectStore(LOCAL_CACHE_STORE);
      const request = store.get(videoId);
      request.onsuccess = () => {
        resolve((request.result as CachedDanmakuRecord | undefined) ?? null);
      };
      request.onerror = () => {
        reject(request.error ?? new Error("MyZ Danmaku: IndexedDB get failed"));
      };
    });
  } catch (error) {
    console.warn("MyZ Danmaku: failed to restore cache", error);
    return null;
  }
}
