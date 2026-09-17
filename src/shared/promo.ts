import {
  CHROME_STORE_URL,
  EDGE_STORE_URL,
  PROMO_SEEN_LIMIT,
  PROMO_SEEN_STORAGE_KEY
} from "./constants";

type PromoSeenMap = Record<string, number>;

async function readPromoSeenMap(): Promise<PromoSeenMap> {
  try {
    const result = await chrome.storage.local.get(PROMO_SEEN_STORAGE_KEY);
    const raw = result[PROMO_SEEN_STORAGE_KEY];
    if (!raw || typeof raw !== "object") {
      return {};
    }
    const entries = Object.entries(raw as Record<string, unknown>).filter(
      (entry): entry is [string, number] =>
        entry[0].length > 0 && typeof entry[1] === "number" && Number.isFinite(entry[1])
    );
    return Object.fromEntries(entries);
  } catch (error) {
    console.warn("MyZ Danmaku: failed to read promo history", error);
    return {};
  }
}

export async function hasPromoBeenShown(videoId?: string | null): Promise<boolean> {
  if (!videoId) {
    return false;
  }
  const map = await readPromoSeenMap();
  return typeof map[videoId] === "number";
}

export async function markPromoShown(videoId?: string | null): Promise<void> {
  if (!videoId) {
    return;
  }
  try {
    const map = await readPromoSeenMap();
    map[videoId] = Date.now();
    const keys = Object.keys(map);
    if (keys.length > PROMO_SEEN_LIMIT) {
      keys
        .sort((a, b) => (map[a] ?? 0) - (map[b] ?? 0))
        .slice(0, keys.length - PROMO_SEEN_LIMIT)
        .forEach(key => {
          delete map[key];
        });
    }
    await chrome.storage.local.set({ [PROMO_SEEN_STORAGE_KEY]: map });
  } catch (error) {
    console.warn("MyZ Danmaku: failed to persist promo history", error);
  }
}

export function resolveStoreUrl(): string {
  try {
    if (/Edg\//i.test(navigator.userAgent)) {
      return EDGE_STORE_URL;
    }
  } catch {
    // ignore inability to read the user agent
  }
  return CHROME_STORE_URL;
}
