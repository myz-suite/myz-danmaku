chrome.action.setBadgeBackgroundColor({ color: "#ff4d4f" }).catch(() => {
  // ignore badge init errors
});

interface DanmakuEntry {
  id: string;
  videoId: string;
  content: string;
  seconds: number;
  author: string;
  publishedText: string;
  likeCount: number;
  isPinned: boolean;
}

const LOCAL_CACHE_DB_NAME = "myz-danmaku-cache";
const LOCAL_CACHE_STORE = "danmaku";
let danmakuDbPromise: Promise<IDBDatabase> | null = null;

async function updateBadgeText(tabId: number, text: string): Promise<void> {
  try {
    await chrome.action.setBadgeText({ tabId, text });
  } catch (error) {
    console.warn("MyZ Danmaku background: failed to update badge", error);
  }
}

function pickBadgeText(count: number) {
  if (!count) {
    return "";
  }
  if (count > 999) {
    return "999+";
  }
  return String(count);
}

function openDanmakuDatabase(): Promise<IDBDatabase> {
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
        reject(request.error ?? new Error("MyZ Danmaku background: failed to open IndexedDB"));
      };
      request.onblocked = () => {
        console.warn("MyZ Danmaku background: IndexedDB open blocked");
      };
    });
    danmakuDbPromise.catch(() => {
      danmakuDbPromise = null;
    });
  }
  return danmakuDbPromise;
}

async function readDanmakuRecord(videoId: string): Promise<DanmakuEntry[] | null> {
  try {
    const db = await openDanmakuDatabase();
    return await new Promise<DanmakuEntry[] | null>((resolve, reject) => {
      const tx = db.transaction(LOCAL_CACHE_STORE, "readonly");
      tx.onerror = () => reject(tx.error ?? new Error("MyZ Danmaku background: read failed"));
      tx.onabort = () => reject(tx.error ?? new Error("MyZ Danmaku background: read aborted"));
      const store = tx.objectStore(LOCAL_CACHE_STORE);
      const request = store.get(videoId);
      request.onsuccess = () => {
        const record = request.result as
          | { videoId: string; storedAt: number; entries: DanmakuEntry[] }
          | undefined;
        resolve(record?.entries ?? null);
      };
      request.onerror = () => {
        reject(request.error ?? new Error("MyZ Danmaku background: get failed"));
      };
    });
  } catch (error) {
    console.warn("MyZ Danmaku background: failed to read cache", error);
    return null;
  }
}

async function writeDanmakuRecord(videoId: string, entries: DanmakuEntry[], storedAt: number): Promise<void> {
  try {
    const db = await openDanmakuDatabase();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(LOCAL_CACHE_STORE, "readwrite");
      tx.onerror = () => reject(tx.error ?? new Error("MyZ Danmaku background: write failed"));
      tx.onabort = () => reject(tx.error ?? new Error("MyZ Danmaku background: write aborted"));
      const store = tx.objectStore(LOCAL_CACHE_STORE);
      const request = store.put({ videoId, storedAt, entries });
      request.onsuccess = () => {
        resolve();
      };
      request.onerror = () => {
        reject(request.error ?? new Error("MyZ Danmaku background: put failed"));
      };
    });
  } catch (error) {
    console.warn("MyZ Danmaku background: failed to persist cache", error);
  }
}

async function handleUpdateRequest(
  tabId: number,
  payload: { videoId: string; preview?: DanmakuEntry[]; count?: number; storedAt?: number }
) {
  const preview = Array.isArray(payload.preview) ? payload.preview.slice() : [];
  const count = typeof payload.count === "number" ? payload.count : preview.length;
  const storedAt = payload.storedAt ?? Date.now();
  await writeDanmakuRecord(payload.videoId, preview, storedAt);
  await updateBadgeText(tabId, pickBadgeText(count));
  return { ok: true as const };
}

async function handleGetRequest(videoId?: string) {
  if (videoId) {
    const persisted = await readDanmakuRecord(videoId);
    if (persisted && persisted.length) {
      return { ok: true as const, danmaku: persisted };
    }
  }
  return { ok: true as const, danmaku: [] as DanmakuEntry[] };
}

async function handleClearRequest(tabId: number) {
  await updateBadgeText(tabId, "");
  return { ok: true as const };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const messageType = message?.type;
  if (messageType === "danmaku:popup-data") {
    handleGetRequest(message.videoId)
      .then(sendResponse)
      .catch(error => {
        console.warn("MyZ Danmaku background: failed to load popup data", error);
        sendResponse({ ok: true as const, danmaku: [] as DanmakuEntry[] });
      });
    return true;
  }

  const tabId = sender.tab?.id ?? message.tabId;
  if (typeof tabId !== "number") {
    sendResponse({ ok: false, error: "Missing tab id" });
    return false;
  }

  switch (messageType) {
    case "danmaku:update": {
      handleUpdateRequest(tabId, message).then(sendResponse);
      return true;
    }
    case "danmaku:get": {
      handleGetRequest(message.videoId).then(sendResponse).catch(error => {
        console.warn("MyZ Danmaku background: failed to serve cache", error);
        sendResponse({ ok: true as const, danmaku: [] as DanmakuEntry[] });
      });
      return true;
    }
    case "danmaku:clear": {
      handleClearRequest(tabId).then(sendResponse);
      return true;
    }
    default: {
      sendResponse({ ok: false, error: "Unknown message" });
      return false;
    }
  }
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.action.setBadgeText({ text: "" }).catch(() => {
    // ignore inability to reset global badge text
  });
});
