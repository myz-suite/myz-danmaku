import Innertube, { ClientType, YT as YTNamespace, YTNodes, Misc, UniversalCache } from "youtubei.js/web";
import { LANGUAGE_STORAGE_KEY } from "./shared/constants";
import { t, onLanguageChange, setLanguage, type Language } from "./shared/i18n";

type CommentNode = YTNodes.CommentView;

type CommentLookup = (key?: string | null) => CommentEntity | undefined;

type NavigableEndpoint = {
  payload?: Record<string, unknown> & {
    watchEndpoint?: Record<string, unknown>;
    startTimeSeconds?: number | string;
    start_time_seconds?: number | string;
    startTimeMs?: number | string;
    start_time_ms?: number | string;
    url?: string;
  };
  toURL?: () => string | undefined;
  metadata?: {
    url?: string;
  };
};

type NavigableRun = {
  endpoint?: NavigableEndpoint;
};

interface CommentEntity {
  commentId?: string;
  commentKey?: string;
  content?: {
    content?: string;
  };
  authorButtonA11y?: string;
  publishedTime?: string;
  likeCount?: number | string;
  voteCount?: number | string;
  voteCountText?: string;
  toolbarStateKey?: string;
  inlineRepliesKey?: string;
}

type CommentEntityMutation = {
  payload?: {
    commentEntityPayload?: {
      key?: string;
      properties?: CommentEntity;
    };
  };
};

type CommentFrameworkUpdateSection = {
  entity_batch_update?: {
    mutations?: CommentEntityMutation[];
  };
  entityBatchUpdate?: {
    mutations?: CommentEntityMutation[];
  };
};

type CommentsFrameworkContainer = {
  framework_updates?: CommentFrameworkUpdateSection;
  frameworkUpdates?: CommentFrameworkUpdateSection;
};

interface NormalizedComment {
  id: string;
  text: string;
  author: string;
  published: string;
  likeCount: number;
  isPinned: boolean;
  runs: NavigableRun[];
}

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

interface CachedDanmakuPayload {
  storedAt: number;
  entries: DanmakuEntry[];
}

interface CachedDanmakuRecord extends CachedDanmakuPayload {
  videoId: string;
}

const FETCH_INTERVAL_MS = 120_000;
const VIDEO_CHECK_INTERVAL_MS = 1_000;
const DISPLAY_LOOKAHEAD = 0.75;
const LOOKBACK_BUFFER = 0.5;
const SEEK_DETECTION_THRESHOLD = 1;
const MAX_FETCH_PAGES = 30;
const COMMENT_SORT_ORDERS = ["TOP_COMMENTS", "NEWEST_FIRST"] as const;
const REQUEST_LIMIT = 10;
const REQUEST_INTERVAL_MS = 5_000;
const MAX_CONCURRENT_REQUESTS = 2;
const OVERLAY_ID = "myz-danmaku-overlay";
const LOCAL_CACHE_DB_NAME = "myz-danmaku-cache";
const LOCAL_CACHE_STORE = "danmaku";

let currentVideoId: string | null = null;
let danmaku: DanmakuEntry[] = [];
let fetchTimer: number | undefined;
let videoPoller: number | undefined;
let overlayContainer: HTMLDivElement | null = null;
let activeVideo: HTMLVideoElement | null = null;
let nextDanmakuIndex = 0;
let isFetchingComments = false;
let fetchPending = false;
let fetchPendingForce = false;
let innertubePromise: Promise<Innertube> | null = null;
let lastKnownVideoTime = 0;
let lastFetchTimestamp = 0;
const displayed = new Set<string>();
const pendingBulletTimers = new Map<string, number>();
const laneAvailability = new Map<number, number>();

type RequestTask = {
  execute: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
};

interface ApplyDanmakuOptions {
  persist?: boolean;
  sync?: boolean;
  final?: boolean;
  merge?: boolean;
}

interface SyncMetadata {
  storedAt?: number;
}

const requestQueue: RequestTask[] = [];
let requestsInFlight = 0;
let requestsStartedInWindow = 0;
let windowStart = 0;
let queueTimer: number | undefined;
let danmakuDbPromise: Promise<IDBDatabase> | null = null;
const BACKGROUND_PREVIEW_LIMIT = 200;
const DANMAKU_BUTTON_ID = "myz-danmaku-send";
const BULLET_SPEED_PX_PER_SEC = 180;
const BULLET_EMIT_PADDING = 48;
const BULLET_FADE_DISTANCE = 160;
const BULLET_LANE_HEIGHT = 40;
const BULLET_WAVE_DELAY_MS = 180;
const BULLET_LANE_GAP_PX = 48;
const LANE_RESERVATION_MS = 300;
const NOTICE_DURATION_MS = 3_000;

// Dynamic language management for content script
async function getStoredLanguage(): Promise<Language> {
  try {
    const result = await chrome.storage.sync.get(LANGUAGE_STORAGE_KEY);
    return (result[LANGUAGE_STORAGE_KEY] as Language) || 'zh_CN';
  } catch {
    return 'zh_CN';
  }
}

function updateContentScriptLanguage(language: Language): void {
  console.log('MyZ Danmaku: Updating content script language to', language);
  
  // Update danmaku button text
  if (danmakuButton) {
    updateDanmakuButtonText(danmakuButton);
  }
  
  // Update any other UI elements that need language updates
  // For now, we only have the danmaku button
}

async function initializeLanguage(): Promise<void> {
  try {
    // Get stored language preference
    const storedLanguage = await getStoredLanguage();
    console.log('MyZ Danmaku: Initializing content script with language', storedLanguage);
    
    // Set the initial language in the I18nManager
    setLanguage(storedLanguage);
    
    // Update UI with initial language
    updateContentScriptLanguage(storedLanguage);
    
    // Listen for language changes from storage (synced across extension components)
    chrome.storage.onChanged.addListener((changes, namespace) => {
      if (namespace === 'sync' && changes[LANGUAGE_STORAGE_KEY]) {
        const newLanguage = changes[LANGUAGE_STORAGE_KEY].newValue as Language;
        console.log('MyZ Danmaku: Language change detected in storage', newLanguage);
        if (newLanguage) {
          // Use setLanguage to ensure proper I18nManager update
          setLanguage(newLanguage);
        }
      }
    });

    // Also listen for our internal language change events
    onLanguageChange((language) => {
      console.log('MyZ Danmaku: Internal language change event', language);
      updateContentScriptLanguage(language);
    });
    
    console.log('MyZ Danmaku: Language initialization complete');
  } catch (error) {
    console.error('MyZ Danmaku: Failed to initialize language', error);
    // Fallback to default language
    setLanguage('zh_CN');
    updateContentScriptLanguage('zh_CN');
  }
}
let danmakuButton: HTMLButtonElement | null = null;
let isDanmakuButtonBusy = false;
let enterKeyHandlerInstalled = false;
let danmakuButtonBusyTimer: number | undefined;
let overlayNoticeElement: HTMLDivElement | null = null;
let overlayNoticeTimer: number | undefined;
const activeBulletAnimations = new Set<Animation>();
const bulletAnimationCleanup = new WeakMap<Animation, () => void>();

function parseTimeParameter(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }
  if (/^\d+$/.test(value)) {
    return Number.parseInt(value, 10);
  }
  const match = value.match(/(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?/i);
  if (!match) {
    return null;
  }
  const hours = match[1] ? Number.parseInt(match[1], 10) : 0;
  const minutes = match[2] ? Number.parseInt(match[2], 10) : 0;
  const seconds = match[3] ? Number.parseInt(match[3], 10) : 0;
  const total = hours * 3_600 + minutes * 60 + seconds;
  return total > 0 ? total : null;
}

function normalizeUrl(input: string | undefined): URL | null {
  if (!input) {
    return null;
  }
  try {
    if (input.startsWith("http")) {
      return new URL(input);
    }
    return new URL(input, window.location.origin);
  } catch {
    return null;
  }
}

function parseColonTimestamp(value: string): number | null {
  const parts = value.split(":");
  if (parts.length < 2 || parts.length > 3) {
    return null;
  }
  const numbers = parts.map(part => Number.parseInt(part, 10));
  if (numbers.some(Number.isNaN)) {
    return null;
  }
  if (parts.length === 3) {
    const [hours, minutes, seconds] = numbers;
    if (minutes < 0 || minutes >= 60 || seconds < 0 || seconds >= 60) {
      return null;
    }
    return hours * 3_600 + minutes * 60 + seconds;
  }
  const [minutes, seconds] = numbers;
  if (seconds < 0 || seconds >= 60) {
    return null;
  }
  return minutes * 60 + seconds;
}

function readTimeValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const numeric = Number.parseFloat(value);
    if (!Number.isNaN(numeric)) {
      return numeric;
    }
  }
  return null;
}

function extractSecondsFromRuns(runs: NavigableRun[]): Set<number> {
  const seconds = new Set<number>();
  runs.forEach(run => {
    const endpoint = run.endpoint;
    if (endpoint?.payload) {
      const payload = endpoint.payload;
      const direct =
        readTimeValue(payload.startTimeSeconds) ??
        readTimeValue(payload.start_time_seconds) ??
        (() => {
          const millis = readTimeValue(payload.startTimeMs) ?? readTimeValue(payload.start_time_ms);
          return typeof millis === "number" ? Math.floor(millis / 1_000) : null;
        })();
      if (typeof direct === "number") {
        seconds.add(Math.floor(direct));
      }
      const watchPayload = payload.watchEndpoint as Record<string, unknown> | undefined;
      if (watchPayload) {
        const nested =
          readTimeValue(watchPayload.startTimeSeconds) ??
          readTimeValue(watchPayload.start_time_seconds) ??
          (() => {
            const millis = readTimeValue(watchPayload.startTimeMs) ?? readTimeValue(watchPayload.start_time_ms);
            return typeof millis === "number" ? Math.floor(millis / 1_000) : null;
          })();
        if (typeof nested === "number") {
          seconds.add(Math.floor(nested));
        }
      }
    }
    const urlCandidate = endpoint?.toURL?.() ?? endpoint?.metadata?.url;
    const url = normalizeUrl(urlCandidate);
    if (url) {
      const queryStart =
        parseTimeParameter(url.searchParams.get("t")) ??
        parseTimeParameter(url.searchParams.get("start"));
      if (queryStart !== null) {
        seconds.add(queryStart);
      }
      if (url.hash) {
        const hashStart = parseTimeParameter(url.hash.replace(/^#/, ""));
        if (hashStart !== null) {
          seconds.add(hashStart);
        }
      }
    }
  });
  return seconds;
}

function extractTimestampsFromText(text: string): number[] {
  const matches = new Set<number>();
  const normalized = text.replace(/[\u200e\u200f]/g, " ");

  const timecodePattern = /\b(?:\d{1,2}:\d{2}:\d{2}|\d{1,4}:\d{2})\b/g;
  let match = timecodePattern.exec(normalized);
  while (match) {
    const parsed = parseColonTimestamp(match[0]);
    if (parsed !== null) {
      matches.add(parsed);
    }
    match = timecodePattern.exec(normalized);
  }

  return Array.from(matches).sort((a, b) => a - b);
}

function makeEntryId(baseId: string, seconds: number): string {
  return `${baseId}:${seconds}`;
}

function toCount(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const digits = value.replace(/[^0-9]/g, "");
    if (digits.length > 0) {
      return Number.parseInt(digits, 10);
    }
  }
  return 0;
}

function resetRequestWindow(now: number): void {
  windowStart = now;
  requestsStartedInWindow = 0;
}

function scheduleQueueFlush(delay: number): void {
  if (queueTimer !== undefined) {
    return;
  }
  queueTimer = window.setTimeout(() => {
    queueTimer = undefined;
    processRequestQueue();
  }, delay);
}

function processRequestQueue(): void {
  const now = Date.now();
  if (windowStart === 0 || now - windowStart >= REQUEST_INTERVAL_MS) {
    resetRequestWindow(now);
  }

  while (
    requestQueue.length > 0 &&
    requestsInFlight < MAX_CONCURRENT_REQUESTS &&
    requestsStartedInWindow < REQUEST_LIMIT
  ) {
    const task = requestQueue.shift();
    if (!task) {
      break;
    }
    requestsInFlight += 1;
    requestsStartedInWindow += 1;
    Promise.resolve()
      .then(task.execute)
      .then(value => {
        task.resolve(value);
      })
      .catch(error => {
        task.reject(error);
      })
      .finally(() => {
        requestsInFlight -= 1;
        processRequestQueue();
      });
  }

  if (requestQueue.length === 0 && queueTimer !== undefined) {
    window.clearTimeout(queueTimer);
    queueTimer = undefined;
    return;
  }

  if (
    requestQueue.length > 0 &&
    (requestsStartedInWindow >= REQUEST_LIMIT || requestsInFlight >= MAX_CONCURRENT_REQUESTS)
  ) {
    const nextWindow = windowStart + REQUEST_INTERVAL_MS;
    const delay = Math.max(0, nextWindow - now);
    scheduleQueueFlush(delay);
  }
}

function enqueueRequest<T>(execute: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    requestQueue.push({
      execute: () => execute() as Promise<unknown>,
      resolve: value => resolve(value as T),
      reject
    });
    processRequestQueue();
  });
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

function setDanmakuButtonBusy(busy: boolean): void {
  isDanmakuButtonBusy = busy;
  if (danmakuButton) {
    danmakuButton.disabled = busy;
    danmakuButton.classList.toggle("is-busy", busy);
    danmakuButton.setAttribute("aria-busy", busy ? "true" : "false");
  }
}

function cleanupBulletAnimation(animation: Animation): void {
  const cleanup = bulletAnimationCleanup.get(animation);
  if (!cleanup) {
    return;
  }
  bulletAnimationCleanup.delete(animation);
  activeBulletAnimations.delete(animation);
  cleanup();
}

function registerBulletAnimation(animation: Animation, cleanup: () => void): void {
  bulletAnimationCleanup.set(animation, cleanup);
  activeBulletAnimations.add(animation);
  const finalize = () => {
    cleanupBulletAnimation(animation);
  };
  animation.addEventListener("finish", finalize, { once: true });
  animation.addEventListener("cancel", finalize, { once: true });
}

function pauseBulletAnimations(): void {
  activeBulletAnimations.forEach(animation => {
    try {
      animation.pause();
    } catch {
      // ignore inability to pause animation
    }
  });
}

function resumeBulletAnimations(): void {
  activeBulletAnimations.forEach(animation => {
    try {
      animation.play();
    } catch {
      // ignore inability to resume animation
    }
  });
}

function clearBulletAnimations(): void {
  Array.from(activeBulletAnimations).forEach(animation => {
    try {
      animation.cancel();
    } catch {
      cleanupBulletAnimation(animation);
    }
  });
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  const tag = target.tagName;
  if (target.isContentEditable) {
    return true;
  }
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || tag === "BUTTON";
}

function installEnterKeyHandler(): void {
  if (enterKeyHandlerInstalled) {
    return;
  }
  const handler = (event: KeyboardEvent) => {
    if (event.key !== "Enter" || event.repeat) {
      return;
    }
    if (isTypingTarget(event.target)) {
      return;
    }
    if (!currentVideoId || !activeVideo) {
      return;
    }
    event.preventDefault();
    handleDanmakuSubmit();
  };
  document.addEventListener("keydown", handler);
  enterKeyHandlerInstalled = true;
}

function showDanmakuNotice(message: string): void {
  const overlay = ensureOverlay();
  if (!overlay.isConnected && activeVideo) {
    attachOverlay(activeVideo);
  }
  if (!overlayNoticeElement || overlayNoticeElement.parentElement !== overlay) {
    overlayNoticeElement?.remove();
    overlayNoticeElement = document.createElement("div");
    overlayNoticeElement.className = "myz-danmaku-notice";
    overlay.appendChild(overlayNoticeElement);
  }
  overlayNoticeElement.textContent = message;
  overlayNoticeElement.classList.add("is-visible");
  if (overlayNoticeTimer !== undefined) {
    window.clearTimeout(overlayNoticeTimer);
  }
  overlayNoticeTimer = window.setTimeout(() => {
    overlayNoticeElement?.classList.remove("is-visible");
    overlayNoticeTimer = undefined;
  }, NOTICE_DURATION_MS);
}

function updateDanmakuButtonText(button: HTMLButtonElement): void {
  button.textContent = t("danmakuButton");
  button.title = t("danmakuButtonTitle");
  button.setAttribute("aria-label", t("danmakuButtonAriaLabel"));
}

function ensureDanmakuButton(_video: HTMLVideoElement): void {
  const controls = document.querySelector<HTMLElement>('.ytp-right-controls') ??
    document.querySelector<HTMLElement>('.ytp-left-controls');
  if (!controls) {
    return;
  }
  let button = danmakuButton ?? document.getElementById(DANMAKU_BUTTON_ID) as HTMLButtonElement | null;
  if (!button) {
    button = document.createElement("button");
    button.id = DANMAKU_BUTTON_ID;
    button.type = "button";
    button.className = "ytp-button myz-danmaku-send";
    updateDanmakuButtonText(button);
    button.addEventListener("click", () => {
      handleDanmakuSubmit();
    });
  }
  if (!button.isConnected) {
    controls.insertBefore(button, controls.firstChild ?? null);
  }
  danmakuButton = button;
  installEnterKeyHandler();
}

function handleDanmakuSubmit(): void {
  if (isDanmakuButtonBusy) {
    return;
  }
  showDanmakuNotice(t("sendUnavailableNotice"));
  if (danmakuButtonBusyTimer !== undefined) {
    window.clearTimeout(danmakuButtonBusyTimer);
  }
  setDanmakuButtonBusy(true);
  danmakuButtonBusyTimer = window.setTimeout(() => {
    setDanmakuButtonBusy(false);
    danmakuButtonBusyTimer = undefined;
  }, NOTICE_DURATION_MS);
}

async function writeDanmakuRecord(record: CachedDanmakuRecord): Promise<void> {
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
  }
}

async function readDanmakuRecord(videoId: string): Promise<CachedDanmakuRecord | null> {
  try {
    const db = await openDanmakuDatabase();
    return await new Promise<CachedDanmakuRecord | null>((resolve, reject) => {
      const tx = db.transaction(LOCAL_CACHE_STORE, "readonly");
      tx.oncomplete = () => {
        // no-op
      };
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

function persistDanmakuSnapshot(videoId: string, entries: DanmakuEntry[]): Promise<number> {
  const sanitized = entries.map(entry => ({ ...entry }));
  const storedAt = Date.now();
  const record: CachedDanmakuRecord = {
    videoId,
    storedAt,
    entries: sanitized
  };
  return writeDanmakuRecord(record).then(() => storedAt);
}

async function restoreDanmakuFromLocal(videoId: string): Promise<CachedDanmakuPayload | null> {
  const record = await readDanmakuRecord(videoId);
  if (!record || !Array.isArray(record.entries)) {
    return null;
  }
  const entries = record.entries
    .map(entry => ({
      ...entry,
      seconds: typeof entry.seconds === "number" ? entry.seconds : Number(entry.seconds) || 0
    }))
    .sort((a, b) => a.seconds - b.seconds);
  return {
    storedAt: typeof record.storedAt === "number" ? record.storedAt : 0,
    entries
  };
}

function runsFromText(text?: Misc.Text | null): NavigableRun[] {
  if (!text) {
    return [];
  }
  const runs: NavigableRun[] = [];
  text.runs?.forEach(run => {
    const endpoint = (run as { endpoint?: NavigableEndpoint }).endpoint;
    if (endpoint) {
      runs.push({ endpoint });
    }
  });
  if (text.endpoint) {
    runs.push({ endpoint: text.endpoint });
  }
  return runs;
}

function collectRunsFromNode(node: CommentNode | undefined | null): NavigableRun[] {
  if (!node) {
    return [];
  }
  return runsFromText(node.content);
}

function textFromNode(node: CommentNode | undefined | null, entity: CommentEntity | undefined): string {
  const candidates: Array<string | undefined> = [node?.content?.toString(), entity?.content?.content];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate;
    }
  }
  return "";
}

function authorFromNode(node: CommentNode | undefined | null, entity: CommentEntity | undefined): string {
  const fromNode = node?.author?.name;
  if (fromNode && fromNode.trim().length > 0) {
    return fromNode;
  }
  const fallback = entity?.authorButtonA11y;
  return fallback && fallback.trim().length > 0 ? fallback : "Unknown";
}

function publishedFromNode(node: CommentNode | undefined | null, entity: CommentEntity | undefined): string {
  const published = node?.published_time;
  if (published && published.trim().length > 0) {
    return published;
  }
  const fallback = entity?.publishedTime;
  return fallback && fallback.trim().length > 0 ? fallback : "";
}

function candidateKeysFromComment(node: CommentNode | undefined | null): string[] {
  if (!node) {
    return [];
  }
  const keys = new Set<string>();
  if (node.comment_id) {
    keys.add(node.comment_id);
  }
  if (node.keys) {
    Object.values(node.keys).forEach(value => {
      if (typeof value === "string" && value.length > 0) {
        keys.add(value);
      }
    });
  }
  return Array.from(keys);
}

function normalizeComment(node: CommentNode | undefined | null, lookup: CommentLookup): NormalizedComment | null {
  if (!node) {
    return null;
  }
  const candidateKeys = candidateKeysFromComment(node);
  const entity = candidateKeys.map(key => lookup(key)).find(Boolean) ?? lookup(node.comment_id);
  const resolvedId = node.comment_id ?? entity?.commentId ?? entity?.commentKey ?? candidateKeys[0];
  if (!resolvedId) {
    return null;
  }
  const text = textFromNode(node, entity);
  const runs = collectRunsFromNode(node);
  const author = authorFromNode(node, entity);
  const published = publishedFromNode(node, entity);
  const likeCount = toCount(
    node.like_count ??
      node.like_count_liked ??
      entity?.likeCount ??
      entity?.voteCount ??
      entity?.voteCountText
  );
  return {
    id: resolvedId,
    text,
    author,
    published,
    likeCount,
    isPinned: Boolean(node.is_pinned),
    runs
  };
}

function addEntriesFromComment(
  videoId: string,
  comment: NormalizedComment,
  bucket: DanmakuEntry[],
  seen: Set<string>
): number {
  const seconds = extractSecondsFromRuns(comment.runs);
  extractTimestampsFromText(comment.text).forEach(value => seconds.add(value));
  const sorted = Array.from(seconds).sort((a, b) => a - b);
  let added = 0;
  sorted.forEach(second => {
    const entryId = makeEntryId(comment.id, second);
    if (seen.has(entryId)) {
      return;
    }
    seen.add(entryId);
    bucket.push({
      id: entryId,
      videoId,
      content: comment.text,
      seconds: second,
      author: comment.author,
      publishedText: comment.published,
      likeCount: comment.likeCount,
      isPinned: comment.isPinned
    });
    added += 1;
  });
  return added;
}

function findFirstDanmakuIndex(target: number): number {
  let low = 0;
  let high = danmaku.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (danmaku[mid].seconds < target) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  return low;
}

function syncDanmakuPointer(currentTime: number, updateLastTime = false): void {
  if (danmaku.length === 0) {
    nextDanmakuIndex = 0;
    if (updateLastTime) {
      lastKnownVideoTime = currentTime;
    }
    return;
  }
  const cutoff = Math.max(0, currentTime - LOOKBACK_BUFFER);
  nextDanmakuIndex = findFirstDanmakuIndex(cutoff);
  if (updateLastTime) {
    lastKnownVideoTime = currentTime;
  }
}

function gatherRepliesFromThread(thread: YTNodes.CommentThread): CommentNode[] {
  const replies: CommentNode[] = [];
  const directReplies = thread.replies;
  if (directReplies) {
    directReplies.forEach(reply => {
      if (reply instanceof YTNodes.CommentView) {
        replies.push(reply);
      }
    });
  }
  const legacyReplies = thread.comment_replies_data?.contents;
  if (legacyReplies) {
    legacyReplies.forEach(item => {
      if (item instanceof YTNodes.CommentView) {
        replies.push(item);
      }
    });
  }
  return replies;
}

async function collectEntriesFromThread(
  videoId: string,
  thread: YTNodes.CommentThread,
  bucket: DanmakuEntry[],
  seen: Set<string>,
  lookup: CommentLookup
): Promise<number> {
  const processed = new Set<string>();
  let produced = 0;
  const emit = (node: CommentNode | null | undefined) => {
    const normalized = normalizeComment(node, lookup);
    if (!normalized || processed.has(normalized.id)) {
      return;
    }
    processed.add(normalized.id);
    produced += addEntriesFromComment(videoId, normalized, bucket, seen);
  };

  emit(thread.comment);
  gatherRepliesFromThread(thread).forEach(reply => emit(reply));

  if (thread.has_replies) {
    try {
      const repliesThread = await enqueueRequest(() => thread.getReplies());
      gatherRepliesFromThread(repliesThread).forEach(reply => emit(reply));
    } catch (error) {
      console.warn("MyZ Danmaku: failed to load replies", error);
    }
  }

  return produced;
}

function indexCommentEntities(page: YTNamespace.Comments, map: Map<string, CommentEntity>): void {
  const response = page.page as unknown as CommentsFrameworkContainer | undefined;
  const frameworkUpdates = response?.framework_updates ?? response?.frameworkUpdates;
  if (!frameworkUpdates) {
    return;
  }
  const batch = frameworkUpdates.entity_batch_update ?? frameworkUpdates.entityBatchUpdate;
  const mutations = batch?.mutations;
  if (!mutations) {
    return;
  }
  mutations.forEach(mutation => {
    const entityPayload = mutation.payload?.commentEntityPayload;
    if (!entityPayload?.properties) {
      return;
    }
    const properties = entityPayload.properties;
    const aliases = new Set<string>();
    [
      properties.commentId,
      properties.commentKey,
      properties.toolbarStateKey,
      properties.inlineRepliesKey,
      entityPayload.key
    ].forEach(key => {
      if (typeof key === "string" && key.length > 0) {
        aliases.add(key);
      }
    });
    aliases.forEach(alias => {
      map.set(alias, properties);
    });
  });
}

function ensureInnertube(): Promise<Innertube> {
  if (!innertubePromise) {
    const fetchFn = window.fetch.bind(window);
    innertubePromise = Innertube.create({
      client_type: ClientType.WEB,
      fetch: fetchFn,
      lang: navigator.language ?? "en",
      location: navigator.language?.split("-")[1] ?? "US",
      generate_session_locally: true,
      retrieve_player: false,
      cache: new UniversalCache(false),
    });
  }
  return innertubePromise;
}

async function loadDanmakuFromInnertube(
  videoId: string,
  onBatch?: (entries: DanmakuEntry[]) => Promise<void> | void
): Promise<DanmakuEntry[]> {
  const client = await ensureInnertube();
  const collected: DanmakuEntry[] = [];
  const seen = new Set<string>();
  const commentEntities = new Map<string, CommentEntity>();
  const lookup: CommentLookup = key => {
    if (!key) {
      return undefined;
    }
    return commentEntities.get(key) ?? undefined;
  };

  for (const sortOrder of COMMENT_SORT_ORDERS) {
      let page: YTNamespace.Comments | null = null;
      try {
        page = await enqueueRequest(() => client.getComments(videoId, sortOrder));
      } catch (error) {
        console.warn(`MyZ Danmaku: failed to load comments with sort "${sortOrder}"`, error);
        continue;
      }
  
      let pageIndex = 0;
      commentEntities.clear();
  
      while (page && pageIndex < MAX_FETCH_PAGES) {
        indexCommentEntities(page, commentEntities);
        for (const thread of page.contents ?? []) {
          if (thread instanceof YTNodes.CommentThread) {
            const added = await collectEntriesFromThread(videoId, thread, collected, seen, lookup);
            if (added > 0 && onBatch) {
              const snapshot = collected.slice().sort((a, b) => a.seconds - b.seconds);
              await onBatch(snapshot);
            }
          }
        }
        pageIndex += 1;
        if (!page.has_continuation) {
          break;
        }
    const currentPage = page as YTNamespace.Comments;
        try {
          page = await enqueueRequest<YTNamespace.Comments>(() => currentPage.getContinuation());
        } catch (error) {
          console.warn("MyZ Danmaku: failed to load continuation", error);
          break;
        }
      }
  }

  collected.sort((a, b) => a.seconds - b.seconds);
  return collected;
}

async function applyDanmakuSnapshot(
  videoId: string,
  entries: DanmakuEntry[],
  options: ApplyDanmakuOptions = {}
): Promise<void> {
  const normalized = entries
    .map(entry => ({
      ...entry,
      seconds: typeof entry.seconds === "number" ? entry.seconds : Number(entry.seconds) || 0
    }))
    .sort((a, b) => a.seconds - b.seconds);

  if (currentVideoId !== videoId) {
    let storedAt: number | undefined;
    if (options.persist) {
      storedAt = await persistDanmakuSnapshot(videoId, normalized);
    }
    if (options.sync) {
      const effectiveStoredAt = storedAt ?? Date.now();
      await syncDanmakuToBackground(videoId, normalized, { storedAt: effectiveStoredAt });
    }
    return;
  }

  let combined: DanmakuEntry[];
  if (options.merge) {
    if (normalized.length === 0) {
      combined = danmaku.slice();
    } else {
      const map = new Map<string, DanmakuEntry>();
      danmaku.forEach(entry => {
        map.set(entry.id, entry);
      });
      normalized.forEach(entry => {
        map.set(entry.id, entry);
      });
      combined = Array.from(map.values());
    }
  } else {
    combined = normalized;
  }

  combined.sort((a, b) => a.seconds - b.seconds);
  danmaku = combined;

  const referenceTime = activeVideo?.currentTime ?? lastKnownVideoTime;
  syncDanmakuPointer(referenceTime, Boolean(activeVideo));

  let storedAt: number | undefined;
  if (options.persist) {
    storedAt = await persistDanmakuSnapshot(videoId, combined);
  }
  if (options.sync) {
    const effectiveStoredAt = storedAt ?? Date.now();
    await syncDanmakuToBackground(videoId, combined, { storedAt: effectiveStoredAt });
  }
  if (options.final) {
    console.info("MyZ Danmaku: applied danmaku", { count: combined.length });
  }
}

async function syncDanmakuToBackground(
  videoId: string,
  entries: DanmakuEntry[],
  metadata: SyncMetadata = {}
): Promise<void> {
  const preview = entries.slice(0, BACKGROUND_PREVIEW_LIMIT);
  const payload = {
    type: "danmaku:update" as const,
    videoId,
    preview,
    count: entries.length,
    storedAt: metadata.storedAt ?? Date.now()
  };
  try {
    await chrome.runtime.sendMessage(payload);
  } catch (error) {
    // Handle extension context invalidated (happens after extension reload)
    if (error && (error as any).message?.includes('Extension context invalidated')) {
      console.debug("MyZ Danmaku: extension context invalidated, stopping sync");
      // Optionally stop further operations since extension was reloaded
      return;
    }
    console.warn("MyZ Danmaku: failed to sync background", error);
  }
}

async function requestDanmaku(videoId: string, force = false): Promise<void> {
  if (!shouldFetchDanmaku(videoId, force)) {
    scheduleNextFetch(videoId);
    return;
  }
  if (isFetchingComments) {
    fetchPending = true;
    fetchPendingForce = fetchPendingForce || force;
    return;
  }

  isFetchingComments = true;
  fetchPending = false;
  fetchPendingForce = false;
  const fetchStartedAt = Date.now();

  try {
    const entries = await loadDanmakuFromInnertube(videoId, async interim => {
      await applyDanmakuSnapshot(videoId, interim, { merge: true, sync: true, persist: true });
    });
    if (currentVideoId !== videoId) {
      return;
    }
    await applyDanmakuSnapshot(videoId, entries, { persist: true, sync: true, final: true });
    lastFetchTimestamp = fetchStartedAt;
    scheduleNextFetch(videoId);
  } catch (error) {
    console.error("MyZ Danmaku: fetch failure", error);
    if (currentVideoId === videoId) {
      scheduleNextFetch(videoId, 60_000, true);
    }
  } finally {
    isFetchingComments = false;
    if (fetchPending && currentVideoId === videoId) {
      const pendingForce = fetchPendingForce;
      fetchPending = false;
      fetchPendingForce = false;
      void requestDanmaku(videoId, pendingForce);
    }
  }
}

function getVideoIdFromLocation(url = window.location.href): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.hostname.includes("youtu.be")) {
      const id = parsed.pathname.replace(/^\//, "");
      return id || null;
    }
    if (parsed.hostname.includes("youtube.com")) {
      return parsed.searchParams.get("v");
    }
  } catch (error) {
    console.warn("MyZ Danmaku: failed to parse location", error);
  }
  return null;
}

function resetState(): void {
  danmaku = [];
  nextDanmakuIndex = 0;
  isFetchingComments = false;
  fetchPending = false;
  fetchPendingForce = false;
  lastKnownVideoTime = 0;
  lastFetchTimestamp = 0;
  displayed.clear();
  clearPendingBulletTimers();
  clearLaneAvailability();
  clearBulletAnimations();
  if (fetchTimer !== undefined) {
    window.clearTimeout(fetchTimer);
    fetchTimer = undefined;
  }
  if (overlayContainer) {
    overlayContainer.innerHTML = "";
  }
  if (overlayNoticeTimer !== undefined) {
    window.clearTimeout(overlayNoticeTimer);
    overlayNoticeTimer = undefined;
  }
  overlayNoticeElement = null;
}

function scheduleNextFetch(videoId: string, delay = FETCH_INTERVAL_MS, force = false): void {
  if (fetchTimer !== undefined) {
    window.clearTimeout(fetchTimer);
  }
  fetchTimer = window.setTimeout(() => {
    if (currentVideoId === videoId) {
      void requestDanmaku(videoId, force);
    }
  }, delay);
}

function ensureOverlay(): HTMLDivElement {
  if (!overlayContainer) {
    overlayContainer = document.createElement("div");
    overlayContainer.id = OVERLAY_ID;
    overlayContainer.className = "myz-danmaku-overlay";
    overlayContainer.setAttribute("aria-hidden", "true");
  }
  return overlayContainer;
}

function attachOverlay(video: HTMLVideoElement): void {
  const parent = video.parentElement;
  if (!parent) {
    return;
  }
  const overlay = ensureOverlay();
  if (overlay.parentElement !== parent) {
    overlay.remove();
    parent.appendChild(overlay);
  }
  overlay.style.width = `${video.clientWidth}px`;
  const halfHeight = Math.max(40, Math.round((video.clientHeight || 0) * 0.5));
  overlay.style.height = `${halfHeight}px`;
  overlay.style.top = "0";
  overlay.setAttribute("aria-hidden", String(!video.isConnected));
}

function getOverlayHeight(overlay: HTMLDivElement): number {
  if (overlay.clientHeight > 0) {
    return overlay.clientHeight;
  }
  if (overlay.offsetHeight > 0) {
    return overlay.offsetHeight;
  }
  const inlineHeight = Number.parseFloat(overlay.style.height || "");
  if (!Number.isNaN(inlineHeight) && inlineHeight > 0) {
    return inlineHeight;
  }
  if (activeVideo) {
    const videoHeight = activeVideo.clientHeight || activeVideo.videoHeight || 0;
    if (videoHeight > 0) {
      return Math.max(BULLET_LANE_HEIGHT, Math.round(videoHeight * 0.5));
    }
  }
  return BULLET_LANE_HEIGHT * 4;
}

function spawnBullet(
  entry: DanmakuEntry,
  laneIndex: number,
  laneHeight: number,
  laneCount: number,
  overlayHeightHint: number
): void {
  const overlay = ensureOverlay();
  if (!overlay.isConnected && activeVideo) {
    attachOverlay(activeVideo);
  }
  const normalizedLaneCount = Math.max(1, Math.floor(laneCount));
  const normalizedLaneHeight = Math.max(
    24,
    Number.isFinite(laneHeight) ? laneHeight : BULLET_LANE_HEIGHT
  );
  const measuredHeight = getOverlayHeight(overlay);
  const effectiveOverlayHeight = Math.max(
    normalizedLaneHeight,
    overlayHeightHint,
    measuredHeight
  );
  const safeLaneIndex = Math.min(Math.max(0, Math.floor(laneIndex)), normalizedLaneCount - 1);
  const maxTop = Math.max(0, effectiveOverlayHeight - normalizedLaneHeight);
  const laneTop = Math.min(maxTop, safeLaneIndex * normalizedLaneHeight);
  const bullet = document.createElement("div");
  bullet.className = "myz-danmaku-bullet";
  bullet.style.top = `${laneTop}px`;
  bullet.textContent = entry.content;
  bullet.dataset.id = entry.id;
  bullet.dataset.lane = String(safeLaneIndex);
  overlay.appendChild(bullet);

  const overlayWidth = overlay.clientWidth || activeVideo?.clientWidth || 640;
  const bulletRect = bullet.getBoundingClientRect();
  const bulletWidth = bulletRect.width || bullet.offsetWidth || 0;
  const now = performance.now();
  const existingReservation = laneAvailability.get(safeLaneIndex) ?? 0;
  if (overlayWidth <= 0) {
    laneAvailability.set(safeLaneIndex, Math.max(existingReservation, now));
    bullet.remove();
    return;
  }
  const occupancyDistance = bulletWidth + BULLET_LANE_GAP_PX;
  const occupancyMs = Math.max(
    LANE_RESERVATION_MS,
    occupancyDistance > 0 ? (occupancyDistance / BULLET_SPEED_PX_PER_SEC) * 1_000 : 0
  );
  const releaseAt = Math.max(existingReservation, now + occupancyMs);
  laneAvailability.set(safeLaneIndex, releaseAt);
  const startX = overlayWidth + BULLET_EMIT_PADDING;
  const endX = -bulletWidth - BULLET_EMIT_PADDING;
  const distance = startX - endX;
  const durationMs = Math.max(distance / BULLET_SPEED_PX_PER_SEC, 4) * 1_000;
  const fadeStartDistance = Math.max(0, distance - BULLET_FADE_DISTANCE);
  const fadeStartOffset = distance > 0 ? fadeStartDistance / distance : 0.85;

  bullet.style.transform = `translate3d(${startX}px, 0, 0)`;
  bullet.style.opacity = "0";

  const animation = bullet.animate(
    [
      { transform: `translate3d(${startX}px, 0, 0)`, opacity: 0 },
      { offset: 0.05, transform: `translate3d(${Math.floor(startX * 0.98)}px, 0, 0)`, opacity: 1 },
      { offset: Math.min(0.95, Math.max(0.85, fadeStartOffset)), opacity: 1 },
      { transform: `translate3d(${endX}px, 0, 0)`, opacity: 0 }
    ],
    {
      duration: durationMs,
      easing: "linear",
      fill: "forwards"
    }
  );

  let fallbackTimer = 0;
  registerBulletAnimation(animation, () => {
    window.clearTimeout(fallbackTimer);
    if (bullet.isConnected) {
      bullet.remove();
    }
  });

  fallbackTimer = window.setTimeout(() => {
    cleanupBulletAnimation(animation);
  }, durationMs + 2_000);

  if (activeVideo && (activeVideo.paused || activeVideo.ended)) {
    try {
      animation.pause();
    } catch {
      // ignore inability to pause animation
    }
  }
}

function clearPendingBulletTimers(): void {
  pendingBulletTimers.forEach(timerId => {
    window.clearTimeout(timerId);
  });
  pendingBulletTimers.clear();
}

function clearLaneAvailability(): void {
  laneAvailability.clear();
}

function pickLane(laneCount: number, baseDelayMs: number): { lane: number; delay: number } {
  const normalizedLaneCount = Math.max(1, Math.floor(laneCount));
  const normalizedDelay = Math.max(0, baseDelayMs);
  const now = performance.now();
  const desiredStart = now + normalizedDelay;

  for (let lane = 0; lane < normalizedLaneCount; lane += 1) {
    const availableAt = laneAvailability.get(lane) ?? 0;
    if (availableAt <= desiredStart) {
      const reservationUntil = desiredStart + LANE_RESERVATION_MS;
      laneAvailability.set(lane, Math.max(reservationUntil, availableAt));
      return { lane, delay: normalizedDelay };
    }
  }

  let bestLane = 0;
  let bestAvailable = Number.POSITIVE_INFINITY;
  for (let lane = 0; lane < normalizedLaneCount; lane += 1) {
    const availableAt = laneAvailability.get(lane) ?? 0;
    if (availableAt < bestAvailable) {
      bestAvailable = availableAt;
      bestLane = lane;
    }
  }

  if (!Number.isFinite(bestAvailable)) {
    bestAvailable = desiredStart;
  }

  const extraDelay = Math.max(0, bestAvailable - desiredStart);
  const finalDelay = normalizedDelay + extraDelay;
  const finalStart = now + finalDelay;
  const reservationUntil = finalStart + LANE_RESERVATION_MS;
  const existing = laneAvailability.get(bestLane) ?? 0;
  laneAvailability.set(bestLane, Math.max(reservationUntil, existing));

  return { lane: bestLane, delay: finalDelay };
}

function queueBulletSpawn(
  entry: DanmakuEntry,
  laneIndex: number,
  laneHeight: number,
  laneCount: number,
  overlayHeight: number,
  delayMs: number
): void {
  if (delayMs <= 0) {
    spawnBullet(entry, laneIndex, laneHeight, laneCount, overlayHeight);
    return;
  }
  const existingTimer = pendingBulletTimers.get(entry.id);
  if (existingTimer !== undefined) {
    window.clearTimeout(existingTimer);
  }
  const timerId = window.setTimeout(() => {
    pendingBulletTimers.delete(entry.id);
    if (currentVideoId !== entry.videoId) {
      return;
    }
    spawnBullet(entry, laneIndex, laneHeight, laneCount, overlayHeight);
  }, delayMs);
  pendingBulletTimers.set(entry.id, timerId);
}

function shouldFetchDanmaku(videoId: string, force: boolean): boolean {
  if (force) {
    return true;
  }
  if (!videoId) {
    return false;
  }
  if (danmaku.length === 0) {
    return true;
  }
  if (!lastFetchTimestamp) {
    return true;
  }
  return Date.now() - lastFetchTimestamp >= FETCH_INTERVAL_MS;
}

function countPendingEntriesForSecond(
  startIndex: number,
  secondKey: number,
  cutoff: number,
  threshold: number
): number {
  let count = 0;
  for (let i = startIndex; i < danmaku.length; i += 1) {
    const candidate = danmaku[i];
    if (candidate.seconds > threshold) {
      break;
    }
    if (candidate.seconds < cutoff) {
      continue;
    }
    const candidateSecondKey = Math.max(0, Math.floor(candidate.seconds));
    if (candidateSecondKey !== secondKey) {
      if (candidateSecondKey > secondKey) {
        break;
      }
      continue;
    }
    if (displayed.has(candidate.id)) {
      continue;
    }
    count += 1;
  }
  return count;
}

function tick(): void {
  if (!activeVideo || danmaku.length === 0) {
    if (activeVideo) {
      lastKnownVideoTime = activeVideo.currentTime;
    }
    return;
  }
  const video = activeVideo;
  if (video.paused || video.ended) {
    pauseBulletAnimations();
    lastKnownVideoTime = video.currentTime;
    return;
  }

  const overlay = ensureOverlay();
  if (!overlay.isConnected) {
    attachOverlay(video);
  }
  const overlayHeight = Math.max(BULLET_LANE_HEIGHT, getOverlayHeight(overlay));
  const baselineLaneHeight = BULLET_LANE_HEIGHT;
  const laneCapacity = Math.max(1, Math.floor(overlayHeight / baselineLaneHeight));

  const currentTime = video.currentTime;
  const delta = currentTime - lastKnownVideoTime;
  if (delta < -SEEK_DETECTION_THRESHOLD) {
    displayed.clear();
    clearPendingBulletTimers();
    clearLaneAvailability();
    clearBulletAnimations();
    syncDanmakuPointer(currentTime, true);
  } else if (delta > SEEK_DETECTION_THRESHOLD) {
    clearPendingBulletTimers();
    clearLaneAvailability();
    clearBulletAnimations();
    syncDanmakuPointer(currentTime);
  }

  const threshold = currentTime + DISPLAY_LOOKAHEAD;
  const cutoff = currentTime - LOOKBACK_BUFFER;

  let currentGroupSecond: number | null = null;
  let currentGroupLaneHeight = baselineLaneHeight;
  let currentGroupLaneCount = laneCapacity;
  let currentGroupLaneIndex = 0;
  let currentGroupWaveDelay = 0;

  while (nextDanmakuIndex < danmaku.length) {
    const entry = danmaku[nextDanmakuIndex];
    if (entry.seconds > threshold) {
      break;
    }
    if (entry.seconds < cutoff) {
      nextDanmakuIndex += 1;
      continue;
    }
    if (displayed.has(entry.id)) {
      nextDanmakuIndex += 1;
      continue;
    }

    const entrySecondKey = Math.max(0, Math.floor(entry.seconds));
    if (currentGroupSecond === null || entrySecondKey !== currentGroupSecond) {
      currentGroupSecond = entrySecondKey;
      currentGroupLaneIndex = 0;
      const pendingInGroup = countPendingEntriesForSecond(
        nextDanmakuIndex,
        entrySecondKey,
        cutoff,
        threshold
      );
      const effectiveGroupSize = Math.max(1, pendingInGroup);
      currentGroupLaneHeight = baselineLaneHeight;
      currentGroupLaneCount = Math.max(1, laneCapacity);
      currentGroupWaveDelay = effectiveGroupSize > laneCapacity ? BULLET_WAVE_DELAY_MS : 0;
    }

    const waveIndex = currentGroupWaveDelay > 0
      ? Math.floor(currentGroupLaneIndex / currentGroupLaneCount)
      : 0;
    const baseDelayMs = currentGroupWaveDelay > 0 ? waveIndex * currentGroupWaveDelay : 0;
    const { lane: laneForEntry, delay: delayMs } = pickLane(currentGroupLaneCount, baseDelayMs);
    currentGroupLaneIndex += 1;

    displayed.add(entry.id);
    queueBulletSpawn(
      entry,
      laneForEntry,
      currentGroupLaneHeight,
      currentGroupLaneCount,
      overlayHeight,
      delayMs
    );
    nextDanmakuIndex += 1;
  }

  lastKnownVideoTime = currentTime;
}

function startTicker(): void {
  const frame = () => {
    tick();
    window.requestAnimationFrame(frame);
  };
  window.requestAnimationFrame(frame);
}

function locateVideoElement(): void {
  const video = document.querySelector<HTMLVideoElement>("video.html5-main-video");
  if (!video) {
    return;
  }
  if (activeVideo === video) {
    attachOverlay(video);
    ensureDanmakuButton(video);
    return;
  }
  activeVideo = video;
  lastKnownVideoTime = video.currentTime;
  attachOverlay(video);
  ensureDanmakuButton(video);
  if (video.paused || video.ended) {
    pauseBulletAnimations();
  } else {
    resumeBulletAnimations();
  }
  if (danmaku.length > 0) {
    syncDanmakuPointer(video.currentTime, true);
  }
  if (!video.dataset.myzDanmakuBound) {
    video.dataset.myzDanmakuBound = "true";
    video.addEventListener("play", () => {
      resumeBulletAnimations();
      if (currentVideoId) {
        void requestDanmaku(currentVideoId);
      }
    });
    video.addEventListener("pause", () => {
      pauseBulletAnimations();
    });
    video.addEventListener("seeked", () => {
      syncDanmakuPointer(video.currentTime, true);
    });
    video.addEventListener("loadeddata", () => {
      syncDanmakuPointer(video.currentTime, true);
    });
  }
}

function ensureVideoPolling(): void {
  if (videoPoller) {
    return;
  }
  locateVideoElement();
  videoPoller = window.setInterval(() => {
    locateVideoElement();
  }, VIDEO_CHECK_INTERVAL_MS);
}

async function refreshOverlayFromCache(videoId: string): Promise<void> {
  try {
    const response = await chrome.runtime.sendMessage({ type: "danmaku:get", videoId });
    if (response?.ok && Array.isArray(response.danmaku)) {
      await applyDanmakuSnapshot(videoId, response.danmaku, { merge: true, persist: true });
    }
  } catch (error) {
    // Handle extension context invalidated gracefully
    if (error && (error as any).message?.includes('Extension context invalidated')) {
      console.debug("MyZ Danmaku: extension context invalidated during cache restore");
      return;
    }
    console.warn("MyZ Danmaku: failed to restore cache", error);
  }
}

async function handleLocationChange(): Promise<void> {
  const videoId = getVideoIdFromLocation();
  if (!videoId) {
    if (currentVideoId) {
      currentVideoId = null;
      resetState();
      try {
        chrome.runtime.sendMessage({ type: "danmaku:clear" }).catch(() => {});
      } catch {
        // Ignore errors if extension context is invalidated
      }
    }
    return;
  }
  if (videoId === currentVideoId) {
    return;
  }
  currentVideoId = videoId;
  resetState();
  ensureVideoPolling();
  const localSnapshot = await restoreDanmakuFromLocal(videoId);
  if (localSnapshot && localSnapshot.entries.length > 0) {
    lastFetchTimestamp = localSnapshot.storedAt;
    await applyDanmakuSnapshot(videoId, localSnapshot.entries, { sync: true });
  }
  await refreshOverlayFromCache(videoId);
  void requestDanmaku(videoId);
}

function installNavigationHooks(): void {
  const realPushState = history.pushState;
  history.pushState = function pushStateReplacement(...args) {
    realPushState.apply(this, args);
    window.setTimeout(() => {
      void handleLocationChange();
    }, 0);
  };
  window.addEventListener("popstate", () => {
    window.setTimeout(() => {
      void handleLocationChange();
    }, 0);
  });
  window.addEventListener("yt-navigate-finish", () => {
    window.setTimeout(() => {
      void handleLocationChange();
    }, 0);
  });
}

function boot(): void {
  initializeLanguage().then(() => {
    installNavigationHooks();
    ensureVideoPolling();
    startTicker();
    void handleLocationChange();
  });
}

if (document.readyState === "complete" || document.readyState === "interactive") {
  boot();
} else {
  document.addEventListener("DOMContentLoaded", boot, { once: true });
}