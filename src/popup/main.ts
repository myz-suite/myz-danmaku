/// <reference types="chrome" />
import "./style.css";
import type { DanmakuEntry } from "../shared/danmaku";
import { t, getCurrentLanguage, setLanguage, onLanguageChange, type Language } from "../shared/i18n";
import {
  getBrowserLanguage,
  getStoredLanguage,
  saveLanguagePreference,
  subscribeToLanguageChanges
} from "../shared/language";
import {
  DEFAULT_SETTINGS as DEFAULT_DANMAKU_SETTINGS,
  getStoredSettings,
  subscribeToSettingsChanges,
  updateSettings,
  type DanmakuSettings
} from "../shared/settings";
import { createPopupRenderer, updateStaticText } from "./ui";

const statusElement = document.querySelector<HTMLElement>('[data-role="status"]');
const listElement = document.querySelector<HTMLUListElement>('[data-role="list"]');
const refreshButton = document.querySelector<HTMLButtonElement>('[data-role="refresh"]');
const settingsButton = document.querySelector<HTMLButtonElement>('[data-role="settings"]');
const languageModal = document.getElementById('languageModal') as HTMLDivElement;
const modalBackdrop = document.querySelector<HTMLElement>('[data-role="modal-backdrop"]');
const modalCloseButton = document.querySelector<HTMLButtonElement>('[data-role="modal-close"]');
const saveLanguageButton = document.querySelector<HTMLButtonElement>('[data-role="save-language"]');
const cancelLanguageButton = document.querySelector<HTMLButtonElement>('[data-role="cancel-language"]');
const languageRadioButtons = document.querySelectorAll<HTMLInputElement>('input[name="language"]');
const fontSizeSelect = document.querySelector<HTMLSelectElement>('[data-role="font-size"]');
const pageCountInput = document.querySelector<HTMLInputElement>('[data-role="page-count"]');

const { setStatus, clearList, renderEntries } = createPopupRenderer({ statusElement, listElement });

// Store the element that had focus before opening the modal
let activeElementBeforeModal: HTMLElement | null = null;
let currentSettings: DanmakuSettings = DEFAULT_DANMAKU_SETTINGS;

function updateHtmlLangAttribute(language: Language): void {
  const html = document.documentElement;
  const langMap: Record<Language, string> = {
    'zh_CN': 'zh-Hans',
    'en': 'en'
  };
  html.lang = langMap[language] || 'zh-Hans';
}

function readFontScaleControl(): number {
  if (!fontSizeSelect) {
    return currentSettings.fontScale;
  }
  const value = Number.parseFloat(fontSizeSelect.value);
  return Number.isFinite(value) ? value : currentSettings.fontScale;
}

function readPageLimitControl(): number {
  if (!pageCountInput) {
    return currentSettings.pageLimit;
  }
  const value = Number.parseInt(pageCountInput.value, 10);
  return Number.isFinite(value) ? value : currentSettings.pageLimit;
}

function syncSettingsControls(settings: DanmakuSettings): void {
  if (fontSizeSelect) {
    const formatted = settings.fontScale.toFixed(2);
    const matchingOption = Array.from(fontSizeSelect.options).find(
      option => Number.parseFloat(option.value).toFixed(2) === formatted
    );
    fontSizeSelect.value = matchingOption ? matchingOption.value : fontSizeSelect.value || "1";
  }
  if (pageCountInput) {
    pageCountInput.value = String(settings.pageLimit);
  }
}

function queryActiveTab(): Promise<chrome.tabs.Tab | null> {
  return new Promise(resolve => {
    chrome.tabs.query({ active: true, lastFocusedWindow: true }, tabs => {
      if (tabs && tabs.length > 0) {
        resolve(tabs[0]);
        return;
      }
      chrome.tabs.query({ active: true, currentWindow: true }, fallbackTabs => {
        resolve(fallbackTabs[0] ?? null);
      });
    });
  });
}

function extractVideoIdFromUrl(url?: string | null): string | null {
  if (!url) {
    return null;
  }
  try {
    const parsed = new URL(url);
    if (parsed.hostname.includes("youtu.be")) {
      const idCandidate = parsed.pathname.replace(/^\//, "").trim();
      return idCandidate.length > 0 ? idCandidate : null;
    }
    if (parsed.hostname.includes("youtube.com")) {
      const idCandidate = parsed.searchParams.get("v");
      if (idCandidate) {
        return idCandidate.trim() || null;
      }
    }
  } catch {
    return null;
  }
  return null;
}

async function fetchDanmakuEntries(videoId?: string | null): Promise<DanmakuEntry[]> {
  const payload: { type: "danmaku:popup-data"; videoId?: string } = {
    type: "danmaku:popup-data"
  };
  if (videoId) {
    payload.videoId = videoId;
  }
  try {
    const response = await chrome.runtime.sendMessage(payload);
    if (response?.ok && Array.isArray(response.danmaku)) {
      return [...response.danmaku].filter((entry: DanmakuEntry) => entry && typeof entry.id === "string");
    }
  } catch (error) {
    if (error && (error as any).message?.includes('Extension context invalidated')) {
      console.debug("MyZ Danmaku popup: extension context invalidated");
      setStatus(t("loadError"), "error");
      return [];
    }
    console.warn("MyZ Danmaku popup: failed to fetch entries", error);
  }
  return [];
}

function sortEntries(entries: DanmakuEntry[]): DanmakuEntry[] {
  return entries
    .filter(entry => typeof entry.seconds === "number" && Number.isFinite(entry.seconds))
    .slice()
    .sort((a, b) => a.seconds - b.seconds);
}

async function loadDanmaku(showSpinner = true): Promise<void> {
  if (showSpinner) {
    setStatus(t("loadingStatus"), "info");
    clearList();
  }

  try {
    const tab = await queryActiveTab();
    const videoId = extractVideoIdFromUrl(tab?.url);
    const entries = sortEntries(await fetchDanmakuEntries(videoId));
    if (entries.length === 0) {
      if (!videoId) {
        setStatus(t("notVideoPage"), "info");
        clearList();
        return;
      }
      setStatus(t("noDanmakuAvailable"), "info");
      clearList();
      return;
    }
    renderEntries(entries);
  } catch (error) {
    console.error("MyZ Danmaku popup: failed to load entries", error);
    setStatus(t("loadError"), "error");
    clearList();
  }
}

// Modal functions
function openLanguageModal(): void {
  // Store the element that triggered the modal
  activeElementBeforeModal = document.activeElement as HTMLElement;
  
  languageModal.classList.add('is-open');
  languageModal.setAttribute('aria-hidden', 'false');
  
  // Set current language as checked
  languageRadioButtons.forEach(radio => {
    radio.checked = radio.value === getCurrentLanguage();
  });
  syncSettingsControls(currentSettings);
  
  // Focus on the modal close button
  modalCloseButton?.focus();
}

function closeLanguageModal(): void {
  languageModal.classList.remove('is-open');
  languageModal.setAttribute('aria-hidden', 'true');
  
  // Return focus to the element that opened the modal, or settings button as fallback
  const elementToFocus = activeElementBeforeModal && document.body.contains(activeElementBeforeModal) 
    ? activeElementBeforeModal 
    : settingsButton;
  
  elementToFocus?.focus();
  activeElementBeforeModal = null;
}

async function handleModalSave(): Promise<void> {
  const selectedLanguage = Array.from(languageRadioButtons).find(radio => radio.checked)?.value as Language;
  let shouldReload = false;
  if (selectedLanguage && selectedLanguage !== getCurrentLanguage()) {
    setLanguage(selectedLanguage);
    updateHtmlLangAttribute(selectedLanguage);
    await saveLanguagePreference(selectedLanguage);
    updateStaticText();
    shouldReload = true;
  }

  const requestedFontScale = readFontScaleControl();
  const requestedPageLimit = readPageLimitControl();
  if (
    requestedFontScale !== currentSettings.fontScale ||
    requestedPageLimit !== currentSettings.pageLimit
  ) {
    currentSettings = await updateSettings({
      fontScale: requestedFontScale,
      pageLimit: requestedPageLimit
    });
    shouldReload = true;
  }

  if (shouldReload) {
    void loadDanmaku(false);
  }

  closeLanguageModal();
}

// Event listeners
refreshButton?.addEventListener("click", () => {
  void loadDanmaku(false);
});

settingsButton?.addEventListener("click", () => {
  openLanguageModal();
});

modalCloseButton?.addEventListener("click", closeLanguageModal);
modalBackdrop?.addEventListener("click", closeLanguageModal);
saveLanguageButton?.addEventListener("click", () => {
  void handleModalSave();
});
cancelLanguageButton?.addEventListener("click", closeLanguageModal);

// Handle Escape key to close modal
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && languageModal.classList.contains('is-open')) {
    closeLanguageModal();
  }
});

// Initialize
async function initialize() {
  const [storedLanguage, storedSettings] = await Promise.all([
    getStoredLanguage(getBrowserLanguage()),
    getStoredSettings()
  ]);
  setLanguage(storedLanguage);
  updateHtmlLangAttribute(storedLanguage);
  updateStaticText();

  currentSettings = storedSettings;
  syncSettingsControls(currentSettings);

  subscribeToLanguageChanges(newLanguage => {
    if (newLanguage && newLanguage !== getCurrentLanguage()) {
      setLanguage(newLanguage);
      updateHtmlLangAttribute(newLanguage);
      updateStaticText();
      void loadDanmaku(false);
    }
  });

  onLanguageChange(() => {
    updateStaticText();
    void loadDanmaku(false);
  });

  subscribeToSettingsChanges(settings => {
    const previous = currentSettings;
    currentSettings = settings;
    syncSettingsControls(settings);
    if (settings.pageLimit !== previous.pageLimit) {
      void loadDanmaku(false);
    }
  });

  void loadDanmaku();
}

void initialize();
