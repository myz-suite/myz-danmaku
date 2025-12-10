import { SETTINGS_STORAGE_KEY } from "./constants";

export interface DanmakuSettings {
  fontScale: number;
  pageLimit: number;
}

export const DEFAULT_SETTINGS: DanmakuSettings = {
  fontScale: 1,
  pageLimit: 30
};

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, value));
}

export function normalizeSettings(input?: Partial<DanmakuSettings> | null): DanmakuSettings {
  const merged: DanmakuSettings = {
    fontScale: DEFAULT_SETTINGS.fontScale,
    pageLimit: DEFAULT_SETTINGS.pageLimit
  };
  if (input) {
    if (typeof input.fontScale === "number") {
      merged.fontScale = input.fontScale;
    }
    if (typeof input.pageLimit === "number") {
      merged.pageLimit = input.pageLimit;
    }
  }
  return {
    fontScale: clamp(merged.fontScale, 0.6, 1.6),
    pageLimit: Math.round(clamp(merged.pageLimit, 1, 60))
  };
}

export async function getStoredSettings(): Promise<DanmakuSettings> {
  try {
    const result = await chrome.storage.sync.get(SETTINGS_STORAGE_KEY);
    const raw = result[SETTINGS_STORAGE_KEY] as Partial<DanmakuSettings> | undefined;
    return normalizeSettings(raw);
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export async function saveSettings(settings: DanmakuSettings): Promise<DanmakuSettings> {
  const normalized = normalizeSettings(settings);
  await chrome.storage.sync.set({ [SETTINGS_STORAGE_KEY]: normalized });
  return normalized;
}

export async function updateSettings(partial: Partial<DanmakuSettings>): Promise<DanmakuSettings> {
  const current = await getStoredSettings();
  return saveSettings({ ...current, ...partial });
}

export function subscribeToSettingsChanges(handler: (settings: DanmakuSettings) => void): () => void {
  const listener: Parameters<typeof chrome.storage.onChanged.addListener>[0] = (changes, namespace) => {
    if (namespace !== "sync" || !changes[SETTINGS_STORAGE_KEY]) {
      return;
    }
    const value = changes[SETTINGS_STORAGE_KEY].newValue as Partial<DanmakuSettings> | undefined;
    handler(normalizeSettings(value));
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}
