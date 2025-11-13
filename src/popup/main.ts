/// <reference types="chrome" />
import "./style.css";
import { LANGUAGE_STORAGE_KEY } from "../shared/constants";
import { t, getCurrentLanguage, setLanguage, onLanguageChange, type Language } from "../shared/i18n";

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

type StatusTone = "info" | "ready" | "error";

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

// Store the element that had focus before opening the modal
let activeElementBeforeModal: HTMLElement | null = null;

// Hybrid i18n strategy:
// 1. Use Chrome i18n for initial language detection (for store compatibility)
// 2. Use our custom i18n for dynamic language switching (for user experience)
// 3. Store user preference in chrome.storage for persistence

function getBrowserLanguage(): Language {
  // Get browser language and map to our supported languages
  const browserLang = navigator.language || navigator.languages[0] || 'zh-CN';
  
  if (browserLang.startsWith('zh')) {
    return 'zh_CN';
  }
  
  if (browserLang.startsWith('en')) {
    return 'en';
  }
  
  // Fallback to Chrome's i18n API if available
  try {
    const chromeLang = chrome.i18n?.getUILanguage?.();
    if (chromeLang?.startsWith('zh')) return 'zh_CN';
    if (chromeLang?.startsWith('en')) return 'en';
  } catch {
    // Chrome i18n not available, use default
  }
  
  return 'zh_CN'; // Default to Chinese
}

async function getStoredLanguage(): Promise<Language> {
  try {
    const result = await chrome.storage.sync.get(LANGUAGE_STORAGE_KEY);
    return (result[LANGUAGE_STORAGE_KEY] as Language) || getBrowserLanguage();
  } catch {
    return getBrowserLanguage();
  }
}

async function saveLanguage(language: Language): Promise<void> {
  try {
    await chrome.storage.sync.set({ [LANGUAGE_STORAGE_KEY]: language });
  } catch (error) {
    console.warn('Failed to save language preference:', error);
  }
}

function updateHtmlLangAttribute(language: Language): void {
  const html = document.documentElement;
  const langMap: Record<Language, string> = {
    'zh_CN': 'zh-Hans',
    'en': 'en'
  };
  html.lang = langMap[language] || 'zh-Hans';
}

// Initialize i18n for static elements
function initializeI18n(): void {
  // Update static text elements
  const elements = document.querySelectorAll<HTMLElement>('[data-i18n]');
  elements.forEach(element => {
    const key = element.dataset.i18n;
    if (key) {
      const text = t(key);
      if (text && text !== key) {
        element.textContent = text;
      }
    }
  });

  // Update aria-label attributes
  const ariaElements = document.querySelectorAll<HTMLElement>('[data-i18n-aria]');
  ariaElements.forEach(element => {
    const key = element.dataset.i18nAria;
    if (key) {
      const text = t(key);
      if (text && text !== key) {
        element.setAttribute('aria-label', text);
      }
    }
  });
  
  // Update page title
  document.title = t('extensionDefaultTitle');
}

function formatTimestamp(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(seconds / 3_600);
  const m = Math.floor((seconds % 3_600) / 60);
  const s = seconds % 60;
  if (h > 0) {
    return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  }
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function setStatus(message: string, tone: StatusTone = "info"): void {
  if (!statusElement) {
    return;
  }
  statusElement.textContent = message;
  statusElement.dataset.tone = tone;
}

function clearList(): void {
  if (!listElement) {
    return;
  }
  while (listElement.firstChild) {
    listElement.removeChild(listElement.firstChild);
  }
}

function renderEntries(entries: DanmakuEntry[]): void {
  if (!statusElement || !listElement) {
    return;
  }
  clearList();
  setStatus(t("danmakuCount", String(entries.length)), "ready");

  entries.forEach(entry => {
    const item = document.createElement("li");
    item.className = "popup__item";
    item.dataset.id = entry.id;

    const header = document.createElement("div");
    header.className = "popup__item-header";

    const timestamp = document.createElement("span");
    timestamp.className = "popup__timestamp";
    timestamp.textContent = formatTimestamp(entry.seconds);
    timestamp.title = entry.publishedText || "";

    const author = document.createElement("span");
    author.className = "popup__author";
    author.textContent = entry.author || t("anonymousAuthor");

    header.appendChild(timestamp);
    header.appendChild(author);

    if (entry.isPinned) {
      const badge = document.createElement("span");
      badge.className = "popup__badge popup__badge--pin";
      badge.textContent = t("pinnedBadge");
      header.appendChild(badge);
    }

    if (entry.likeCount > 0) {
      const likes = document.createElement("span");
      likes.className = "popup__meta popup__meta--likes";
      likes.textContent = t("likeCount", String(entry.likeCount));
      header.appendChild(likes);
    }

    item.appendChild(header);

    const body = document.createElement("p");
    body.className = "popup__content";
    body.textContent = entry.content;
    item.appendChild(body);

    listElement.appendChild(item);
  });
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

function saveLanguageSelection(): void {
  const selectedLanguage = Array.from(languageRadioButtons).find(radio => radio.checked)?.value as Language;
  if (selectedLanguage && selectedLanguage !== getCurrentLanguage()) {
    setLanguage(selectedLanguage);
    updateHtmlLangAttribute(selectedLanguage);
    void saveLanguage(selectedLanguage);
    
    // Re-initialize UI with new language
    initializeI18n();
    
    // Refresh the danmaku list to update dynamic content
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
saveLanguageButton?.addEventListener("click", saveLanguageSelection);
cancelLanguageButton?.addEventListener("click", closeLanguageModal);

// Handle Escape key to close modal
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && languageModal.classList.contains('is-open')) {
    closeLanguageModal();
  }
});

// Initialize
async function initialize() {
  // Get stored language preference or detect browser language
  const storedLanguage = await getStoredLanguage();
  setLanguage(storedLanguage);
  updateHtmlLangAttribute(storedLanguage);
  
  // Listen for language changes from storage (triggered by other parts of extension)
  chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace === 'sync' && changes[LANGUAGE_STORAGE_KEY]) {
      const newLanguage = changes[LANGUAGE_STORAGE_KEY].newValue as Language;
      if (newLanguage && newLanguage !== getCurrentLanguage()) {
        setLanguage(newLanguage);
        updateHtmlLangAttribute(newLanguage);
        initializeI18n();
        void loadDanmaku(false);
      }
    }
  });
  
  // Listen for our internal language changes
  onLanguageChange(() => {
    initializeI18n();
    void loadDanmaku(false);
  });
  
  // Initialize i18n
  initializeI18n();
  
  // Load danmaku
  void loadDanmaku();
}

void initialize();