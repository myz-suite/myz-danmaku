import type { DanmakuEntry } from "../shared/danmaku";
import { t } from "../shared/i18n";

export type StatusTone = "info" | "ready" | "error";

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

export function updateStaticText(root: Document = document): void {
  const elements = root.querySelectorAll<HTMLElement>("[data-i18n]");
  elements.forEach(element => {
    const key = element.dataset.i18n;
    if (key) {
      const text = t(key);
      if (text && text !== key) {
        element.textContent = text;
      }
    }
  });

  const ariaElements = root.querySelectorAll<HTMLElement>("[data-i18n-aria]");
  ariaElements.forEach(element => {
    const key = element.dataset.i18nAria;
    if (key) {
      const text = t(key);
      if (text && text !== key) {
        element.setAttribute("aria-label", text);
      }
    }
  });

  root.title = t("extensionDefaultTitle");
}

export function createPopupRenderer(options: {
  statusElement: HTMLElement | null;
  listElement: HTMLUListElement | null;
}) {
  const { statusElement, listElement } = options;

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

  return { setStatus, clearList, renderEntries };
}
