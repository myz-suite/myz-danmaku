import { loadDanmakuFromInnertube, splitMultiLineTimestampComment } from "./content/network";
import {
  attachOverlay,
  clearBulletAnimations,
  clearLaneAvailability,
  clearPendingBulletTimers,
  ensureDanmakuButton,
  ensureOverlay,
  flashDanmakuUnavailable,
  getOverlayHeight,
  OVERLAY_BASE_LANE_HEIGHT,
  OVERLAY_WAVE_DELAY_MS,
  pauseBulletAnimations,
  reserveLane,
  queueBulletSpawn,
  queuePromoBullet,
  resetOverlayUi,
  resumeBulletAnimations,
  setOverlayFontScale,
  updateTimelineIndicators,
  updateDanmakuButtonLanguage,
  type OverlayContext
} from "./content/ui";
import type { CachedDanmakuPayload, DanmakuEntry } from "./shared/danmaku";
import { t, onLanguageChange, setLanguage, type Language } from "./shared/i18n";
import { getStoredLanguage, subscribeToLanguageChanges } from "./shared/language";
import { hasPromoBeenShown, markPromoShown, resolveStoreUrl } from "./shared/promo";
import {
  DEFAULT_SETTINGS,
  getStoredSettings,
  subscribeToSettingsChanges,
  type DanmakuSettings
} from "./shared/settings";
import { readDanmakuRecord, writeDanmakuRecord } from "./shared/storage";

const FETCH_INTERVAL_MS = 120_000;
const VIDEO_CHECK_INTERVAL_MS = 1_000;
const DISPLAY_LOOKAHEAD = 0.75;
const LOOKBACK_BUFFER = 0.5;
const SEEK_DETECTION_THRESHOLD = 1;
const BACKGROUND_PREVIEW_LIMIT = 200;

let currentVideoId: string | null = null;
let danmaku: DanmakuEntry[] = [];
let fetchTimer: number | undefined;
let videoPoller: number | undefined;
let activeVideo: HTMLVideoElement | null = null;
let nextDanmakuIndex = 0;
let isFetchingComments = false;
let fetchPending = false;
let fetchPendingForce = false;
let lastKnownVideoTime = 0;
let lastFetchTimestamp = 0;
let promoPending = false;
const displayed = new Set<string>();
let currentSettings: DanmakuSettings = DEFAULT_SETTINGS;
setOverlayFontScale(currentSettings.fontScale);

interface ApplyDanmakuOptions {
  persist?: boolean;
  sync?: boolean;
  final?: boolean;
  merge?: boolean;
}

interface SyncMetadata {
  storedAt?: number;
}

function getOverlayContext(): OverlayContext {
  return {
    currentVideoId,
    activeVideo
  };
}

function applySettings(settings: DanmakuSettings): void {
  currentSettings = settings;
  setOverlayFontScale(settings.fontScale);
  if (!settings.promoEnabled) {
    promoPending = false;
  }
}

function refineLegacyMultilineEntry(entry: DanmakuEntry): DanmakuEntry {
  if (!entry.content.includes("\n")) {
    return entry;
  }
  const segments = splitMultiLineTimestampComment(entry.content);
  if (!segments || segments.length === 0) {
    return entry;
  }
  const targetSecond = Math.floor(entry.seconds);
  const match = segments.find(segment => Math.floor(segment.seconds) === targetSecond);
  if (!match || match.content === entry.content) {
    return entry;
  }
  return {
    ...entry,
    content: match.content
  };
}

function updateContentScriptLanguage(language: Language): void {
  console.log("MyZ Danmaku: updating content language", language);
  updateDanmakuButtonLanguage();
}

async function initializeLanguage(): Promise<void> {
  try {
    const storedLanguage = await getStoredLanguage("zh_CN");
    console.log("MyZ Danmaku: booting with language", storedLanguage);
    setLanguage(storedLanguage);
    updateContentScriptLanguage(storedLanguage);

    subscribeToLanguageChanges(language => {
      if (!language) {
        return;
      }
      console.log("MyZ Danmaku: storage language change", language);
      setLanguage(language);
      updateContentScriptLanguage(language);
    });

    onLanguageChange(language => {
      console.log("MyZ Danmaku: local language change", language);
      updateContentScriptLanguage(language);
    });
  } catch (error) {
    console.error("MyZ Danmaku: failed to init language", error);
    setLanguage("zh_CN");
    updateContentScriptLanguage("zh_CN");
  }
}

async function initializeSettings(): Promise<void> {
  try {
    const storedSettings = await getStoredSettings();
    applySettings(storedSettings);
  } catch (error) {
    console.warn("MyZ Danmaku: failed to load settings", error);
    applySettings(DEFAULT_SETTINGS);
  }
  subscribeToSettingsChanges(settings => {
    const previous = currentSettings;
    applySettings(settings);
    if (previous.pageLimit !== settings.pageLimit && currentVideoId) {
      void requestDanmaku(currentVideoId, true);
    }
  });
}

async function persistDanmakuSnapshot(videoId: string, entries: DanmakuEntry[]): Promise<number> {
  const sanitized = entries.map(entry => ({ ...entry }));
  const storedAt = Date.now();
  await writeDanmakuRecord({ videoId, storedAt, entries: sanitized });
  return storedAt;
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
  combined = combined.map(refineLegacyMultilineEntry);
  danmaku = combined;

  const referenceTime = activeVideo?.currentTime ?? lastKnownVideoTime;
  syncDanmakuPointer(referenceTime, Boolean(activeVideo));
  updateTimelineIndicators(activeVideo, videoId, combined);

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
    if (error && (error as any).message?.includes("Extension context invalidated")) {
      console.debug("MyZ Danmaku: extension context invalidated during sync");
      return;
    }
    console.warn("MyZ Danmaku: failed to sync background", error);
  }
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
  const loadOptions = { maxPages: currentSettings.pageLimit };

  try {
    const entries = await loadDanmakuFromInnertube(
      videoId,
      async interim => {
        await applyDanmakuSnapshot(videoId, interim, { merge: true, sync: true, persist: true });
      },
      loadOptions
    );
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
  promoPending = false;
  displayed.clear();
  clearPendingBulletTimers();
  clearLaneAvailability();
  clearBulletAnimations();
  resetOverlayUi();
  if (fetchTimer !== undefined) {
    window.clearTimeout(fetchTimer);
    fetchTimer = undefined;
  }
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
  const overlayHeight = Math.max(OVERLAY_BASE_LANE_HEIGHT, getOverlayHeight(overlay, video));
  const baselineLaneHeight = OVERLAY_BASE_LANE_HEIGHT;
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
      currentGroupWaveDelay = effectiveGroupSize > laneCapacity ? OVERLAY_WAVE_DELAY_MS : 0;
    }

    if (promoPending) {
      promoPending = false;
      const promoReservation = reserveLane(currentGroupLaneCount, 0);
      queuePromoBullet(
        {
          text: t("promoText"),
          href: resolveStoreUrl(),
          title: t("promoLinkTitle")
        },
        promoReservation.lane,
        currentGroupLaneHeight,
        currentGroupLaneCount,
        overlayHeight,
        getOverlayContext()
      );
      currentGroupLaneIndex += 1;
      void markPromoShown(currentVideoId);
    }

    const waveIndex = currentGroupWaveDelay > 0
      ? Math.floor(currentGroupLaneIndex / currentGroupLaneCount)
      : 0;
    const baseDelayMs = currentGroupWaveDelay > 0 ? waveIndex * currentGroupWaveDelay : 0;
    const { lane: laneForEntry, delay: delayMs } = reserveLane(currentGroupLaneCount, baseDelayMs);
    currentGroupLaneIndex += 1;

    displayed.add(entry.id);
    queueBulletSpawn(
      entry,
      laneForEntry,
      currentGroupLaneHeight,
      currentGroupLaneCount,
      overlayHeight,
      delayMs,
      getOverlayContext()
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
    ensureDanmakuButton(video, {
      onSubmit: handleDanmakuSubmit,
      canSubmit: () => Boolean(currentVideoId && activeVideo)
    });
    updateTimelineIndicators(video, currentVideoId, danmaku);
    return;
  }
  activeVideo = video;
  lastKnownVideoTime = video.currentTime;
  attachOverlay(video);
  ensureDanmakuButton(video, {
    onSubmit: handleDanmakuSubmit,
    canSubmit: () => Boolean(currentVideoId && activeVideo)
  });
  updateTimelineIndicators(video, currentVideoId, danmaku);
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
    const timelineRefresh = () => {
      if (activeVideo === video) {
        updateTimelineIndicators(video, currentVideoId, danmaku);
      }
    };
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
    video.addEventListener("loadedmetadata", timelineRefresh);
    video.addEventListener("durationchange", timelineRefresh);
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
    if (error && (error as any).message?.includes("Extension context invalidated")) {
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
        // ignore context errors
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
  const [localSnapshot, promoAlreadyShown] = await Promise.all([
    restoreDanmakuFromLocal(videoId),
    hasPromoBeenShown(videoId)
  ]);
  const hasCachedDanmaku = Boolean(localSnapshot && localSnapshot.entries.length > 0);
  promoPending = currentSettings.promoEnabled && !promoAlreadyShown && !hasCachedDanmaku;
  if (hasCachedDanmaku && localSnapshot) {
    lastFetchTimestamp = localSnapshot.storedAt;
    await applyDanmakuSnapshot(videoId, localSnapshot.entries, { sync: true });
  }
  await refreshOverlayFromCache(videoId);
  if (danmaku.length > 0) {
    promoPending = false;
  }
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

function handleDanmakuSubmit(): void {
  flashDanmakuUnavailable(t("sendUnavailableNotice"), getOverlayContext());
}

function boot(): void {
  Promise.all([initializeLanguage(), initializeSettings()])
    .catch(error => {
      console.warn("MyZ Danmaku: initialization warning", error);
    })
    .finally(() => {
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
