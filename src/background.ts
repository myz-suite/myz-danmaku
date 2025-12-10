import type { DanmakuEntry } from "./shared/danmaku";
import { readDanmakuRecord, writeDanmakuRecord } from "./shared/storage";

chrome.action.setBadgeBackgroundColor({ color: "#ff4d4f" }).catch(() => {
  // ignore badge init errors
});

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

async function handleUpdateRequest(
  tabId: number,
  payload: { videoId: string; preview?: DanmakuEntry[]; count?: number; storedAt?: number }
) {
  const preview = Array.isArray(payload.preview) ? payload.preview.slice() : [];
  const count = typeof payload.count === "number" ? payload.count : preview.length;
  const storedAt = payload.storedAt ?? Date.now();
  await writeDanmakuRecord({ videoId: payload.videoId, entries: preview, storedAt });
  await updateBadgeText(tabId, pickBadgeText(count));
  return { ok: true as const };
}

async function handleGetRequest(videoId?: string) {
  if (videoId) {
    const persisted = await readDanmakuRecord(videoId);
    if (persisted?.entries?.length) {
      return { ok: true as const, danmaku: persisted.entries };
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
