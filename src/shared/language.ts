import { LANGUAGE_STORAGE_KEY } from "./constants";
import type { Language } from "./i18n";

export function getBrowserLanguage(): Language {
  const browserLang = navigator.language || navigator.languages[0] || "zh-CN";
  if (browserLang.toLowerCase().startsWith("zh")) {
    return "zh_CN";
  }
  if (browserLang.toLowerCase().startsWith("en")) {
    return "en";
  }
  try {
    const chromeLang = chrome.i18n?.getUILanguage?.();
    if (chromeLang?.toLowerCase().startsWith("zh")) {
      return "zh_CN";
    }
    if (chromeLang?.toLowerCase().startsWith("en")) {
      return "en";
    }
  } catch {
    // ignore chrome i18n errors
  }
  return "zh_CN";
}

export async function getStoredLanguage(fallback: Language = "zh_CN"): Promise<Language> {
  try {
    const result = await chrome.storage.sync.get(LANGUAGE_STORAGE_KEY);
    return (result[LANGUAGE_STORAGE_KEY] as Language) || fallback || getBrowserLanguage();
  } catch {
    return fallback || getBrowserLanguage();
  }
}

export async function saveLanguagePreference(language: Language): Promise<void> {
  try {
    await chrome.storage.sync.set({ [LANGUAGE_STORAGE_KEY]: language });
  } catch (error) {
    console.warn("MyZ Danmaku: failed to persist language preference", error);
  }
}

export function subscribeToLanguageChanges(handler: (language: Language) => void): () => void {
  const listener: Parameters<typeof chrome.storage.onChanged.addListener>[0] = (changes, namespace) => {
    if (namespace === "sync" && changes[LANGUAGE_STORAGE_KEY]) {
      const nextLanguage = changes[LANGUAGE_STORAGE_KEY].newValue as Language;
      if (nextLanguage) {
        handler(nextLanguage);
      }
    }
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}
