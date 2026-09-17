import type { DanmakuEntry } from "../shared/danmaku";
import { t } from "../shared/i18n";

const OVERLAY_ID = "myz-danmaku-overlay";
const DANMAKU_BUTTON_ID = "myz-danmaku-send";
const BULLET_SPEED_PX_PER_SEC = 180;
const BULLET_EMIT_PADDING = 48;
const BULLET_LANE_HEIGHT = 40;
const BULLET_WAVE_DELAY_MS = 180;
const BULLET_LANE_GAP_PX = 48;
const LANE_RESERVATION_MS = 300;
const NOTICE_DURATION_MS = 3_000;
const TIMELINE_CONTAINER_ID = "myz-danmaku-progress-indicators";

let overlayContainer: HTMLDivElement | null = null;
let overlayNoticeElement: HTMLDivElement | null = null;
let overlayNoticeTimer: number | undefined;
const activeBulletAnimations = new Set<Animation>();
const bulletAnimationCleanup = new WeakMap<Animation, () => void>();
const pendingBulletTimers = new Map<string, number>();
const laneAvailability = new Map<number, number>();
let danmakuButton: HTMLButtonElement | null = null;
let isDanmakuButtonBusy = false;
let enterKeyHandlerInstalled = false;
let enterKeyHandlerCanSubmit: (() => boolean) | null = null;
let enterKeyHandlerSubmit: (() => void) | null = null;
let danmakuButtonBusyTimer: number | undefined;
let timelineContainer: HTMLDivElement | null = null;
let timelinePendingData: { videoId: string; seconds: number[]; duration: number } | null = null;
let timelineRetryTimer: number | undefined;
let overlayFontScale = 1;

export interface OverlayContext {
  currentVideoId: string | null;
  activeVideo: HTMLVideoElement | null;
}

function applyFontScale(target: HTMLDivElement | null): void {
  if (target) {
    target.style.setProperty("--myz-danmaku-font-scale", overlayFontScale.toString());
  }
}

function getOverlayInstance(): HTMLDivElement {
  if (!overlayContainer) {
    overlayContainer = document.createElement("div");
    overlayContainer.id = OVERLAY_ID;
    overlayContainer.className = "myz-danmaku-overlay";
    overlayContainer.setAttribute("aria-hidden", "true");
    applyFontScale(overlayContainer);
  }
  return overlayContainer;
}

export function ensureOverlay(): HTMLDivElement {
  const overlay = getOverlayInstance();
  applyFontScale(overlay);
  return overlay;
}

export function attachOverlay(video: HTMLVideoElement): void {
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

export function getOverlayHeight(overlay: HTMLDivElement, video?: HTMLVideoElement | null): number {
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
  if (video) {
    const videoHeight = video.clientHeight || video.videoHeight || 0;
    if (videoHeight > 0) {
      return Math.max(BULLET_LANE_HEIGHT, Math.round(videoHeight * 0.5));
    }
  }
  return BULLET_LANE_HEIGHT * 4;
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

export function pauseBulletAnimations(): void {
  activeBulletAnimations.forEach(animation => {
    try {
      animation.pause();
    } catch {
      // ignore inability to pause animation
    }
  });
}

export function resumeBulletAnimations(): void {
  activeBulletAnimations.forEach(animation => {
    try {
      animation.play();
    } catch {
      // ignore inability to resume animation
    }
  });
}

export function clearBulletAnimations(): void {
  Array.from(activeBulletAnimations).forEach(animation => {
    try {
      animation.cancel();
    } catch {
      cleanupBulletAnimation(animation);
    }
  });
}

export function clearPendingBulletTimers(): void {
  pendingBulletTimers.forEach(timerId => {
    window.clearTimeout(timerId);
  });
  pendingBulletTimers.clear();
}

export function clearLaneAvailability(): void {
  laneAvailability.clear();
}

function getProgressRoot(): HTMLElement | null {
  return (
    document.querySelector<HTMLElement>(".ytp-progress-bar-container") ??
    document.querySelector<HTMLElement>(".ytp-progress-bar")
  );
}

function ensureTimelineContainer(): HTMLDivElement | null {
  const root = getProgressRoot();
  if (!root) {
    timelineContainer?.remove();
    timelineContainer = null;
    return null;
  }
  if (!timelineContainer || timelineContainer.parentElement !== root) {
    timelineContainer?.remove();
    timelineContainer = document.createElement("div");
    timelineContainer.id = TIMELINE_CONTAINER_ID;
    timelineContainer.className = "myz-danmaku-progress-indicators";
    root.appendChild(timelineContainer);
  }
  return timelineContainer;
}

function scheduleTimelineRetry(): void {
  if (timelineRetryTimer !== undefined) {
    return;
  }
  timelineRetryTimer = window.setInterval(() => {
    if (!timelinePendingData) {
      return;
    }
    const container = ensureTimelineContainer();
    if (container) {
      renderTimelineMarkers(container, timelinePendingData);
      clearTimelineRetry();
    }
  }, 500);
}

function clearTimelineRetry(): void {
  if (timelineRetryTimer !== undefined) {
    window.clearInterval(timelineRetryTimer);
    timelineRetryTimer = undefined;
  }
}

function clearTimelineMarkers(): void {
  timelineContainer?.remove();
  timelineContainer = null;
  timelinePendingData = null;
  clearTimelineRetry();
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

export function reserveLane(laneCount: number, baseDelayMs: number): { lane: number; delay: number } {
  return pickLane(laneCount, baseDelayMs);
}

function mountBulletElement(
  bullet: HTMLElement,
  laneIndex: number,
  laneHeight: number,
  laneCount: number,
  overlayHeightHint: number,
  context: OverlayContext
): void {
  const overlay = ensureOverlay();
  if (!overlay.isConnected && context.activeVideo) {
    attachOverlay(context.activeVideo);
  }
  const normalizedLaneCount = Math.max(1, Math.floor(laneCount));
  const normalizedLaneHeight = Math.max(24, Number.isFinite(laneHeight) ? laneHeight : BULLET_LANE_HEIGHT);
  const measuredHeight = getOverlayHeight(overlay, context.activeVideo ?? undefined);
  const effectiveOverlayHeight = Math.max(
    normalizedLaneHeight,
    overlayHeightHint,
    measuredHeight
  );
  const safeLaneIndex = Math.min(Math.max(0, Math.floor(laneIndex)), normalizedLaneCount - 1);
  const maxTop = Math.max(0, effectiveOverlayHeight - normalizedLaneHeight);
  const laneTop = Math.min(maxTop, safeLaneIndex * normalizedLaneHeight);
  bullet.style.top = `${laneTop}px`;
  bullet.dataset.lane = String(safeLaneIndex);
  overlay.appendChild(bullet);

  const overlayWidth = overlay.clientWidth || context.activeVideo?.clientWidth || 640;
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
  bullet.style.transform = `translate3d(${startX}px, 0, 0)`;

  const animation = bullet.animate(
    [
      { transform: `translate3d(${startX}px, 0, 0)`, opacity: 1 },
      { transform: `translate3d(${endX}px, 0, 0)`, opacity: 1 }
    ],
    {
      duration: durationMs,
      easing: "linear",
      fill: "forwards"
    }
  );
  const cleanup = () => {
    bullet.remove();
  };
  registerBulletAnimation(animation, cleanup);

  let fallbackTimer: number | undefined;
  animation.addEventListener(
    "finish",
    () => {
      if (fallbackTimer !== undefined) {
        window.clearTimeout(fallbackTimer);
        fallbackTimer = undefined;
      }
      cleanupBulletAnimation(animation);
    },
    { once: true }
  );

  fallbackTimer = window.setTimeout(() => {
    cleanupBulletAnimation(animation);
  }, durationMs + 2_000);

  if (context.activeVideo && (context.activeVideo.paused || context.activeVideo.ended)) {
    try {
      animation.pause();
    } catch {
      // ignore inability to pause animation
    }
  }
}

function spawnBullet(
  entry: DanmakuEntry,
  laneIndex: number,
  laneHeight: number,
  laneCount: number,
  overlayHeightHint: number,
  context: OverlayContext
): void {
  const bullet = document.createElement("div");
  bullet.className = "myz-danmaku-bullet";
  bullet.textContent = entry.content;
  bullet.dataset.id = entry.id;
  mountBulletElement(bullet, laneIndex, laneHeight, laneCount, overlayHeightHint, context);
}

export interface PromoBulletOptions {
  text: string;
  href: string;
  title?: string;
}

export function queuePromoBullet(
  options: PromoBulletOptions,
  laneIndex: number,
  laneHeight: number,
  laneCount: number,
  overlayHeightHint: number,
  context: OverlayContext
): void {
  const bullet = document.createElement("a");
  bullet.className = "myz-danmaku-bullet myz-danmaku-bullet--promo";
  bullet.textContent = options.text;
  bullet.href = options.href;
  bullet.target = "_blank";
  bullet.rel = "noopener noreferrer";
  bullet.dataset.promo = "true";
  if (options.title) {
    bullet.title = options.title;
  }
  mountBulletElement(bullet, laneIndex, laneHeight, laneCount, overlayHeightHint, context);
}

export function queueBulletSpawn(
  entry: DanmakuEntry,
  laneIndex: number,
  laneHeight: number,
  laneCount: number,
  overlayHeight: number,
  delayMs: number,
  context: OverlayContext
): void {
  if (delayMs <= 0) {
    spawnBullet(entry, laneIndex, laneHeight, laneCount, overlayHeight, context);
    return;
  }
  const existingTimer = pendingBulletTimers.get(entry.id);
  if (existingTimer !== undefined) {
    window.clearTimeout(existingTimer);
  }
  const timerId = window.setTimeout(() => {
    pendingBulletTimers.delete(entry.id);
    if (context.currentVideoId !== entry.videoId) {
      return;
    }
    spawnBullet(entry, laneIndex, laneHeight, laneCount, overlayHeight, context);
  }, delayMs);
  pendingBulletTimers.set(entry.id, timerId);
}

export function resetOverlayUi(): void {
  if (overlayNoticeTimer !== undefined) {
    window.clearTimeout(overlayNoticeTimer);
    overlayNoticeTimer = undefined;
  }
  overlayNoticeElement?.remove();
  overlayNoticeElement = null;
  overlayContainer?.remove();
  overlayContainer = null;
  danmakuButtonBusyTimer = undefined;
  clearTimelineMarkers();
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

function installEnterKeyHandler(canSubmit: () => boolean, onSubmit: () => void): void {
  enterKeyHandlerCanSubmit = canSubmit;
  enterKeyHandlerSubmit = onSubmit;
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
    if (!enterKeyHandlerCanSubmit || !enterKeyHandlerCanSubmit()) {
      return;
    }
    enterKeyHandlerSubmit?.();
  };
  document.addEventListener("keydown", handler, { passive: true });
  enterKeyHandlerInstalled = true;
}

export function ensureDanmakuButton(
  video: HTMLVideoElement,
  options: { onSubmit: () => void; canSubmit: () => boolean }
): void {
  const controls =
    document.querySelector<HTMLElement>(".ytp-right-controls") ??
    document.querySelector<HTMLElement>(".ytp-left-controls");
  if (!controls) {
    return;
  }
  let button = danmakuButton ?? (document.getElementById(DANMAKU_BUTTON_ID) as HTMLButtonElement | null);
  if (!button) {
    button = document.createElement("button");
    button.id = DANMAKU_BUTTON_ID;
    button.type = "button";
    button.className = "ytp-button myz-danmaku-send";
    updateDanmakuButtonText(button);
    button.addEventListener("click", () => {
      if (options.canSubmit()) {
        options.onSubmit();
      }
    });
  }
  if (!button.isConnected) {
    controls.insertBefore(button, controls.firstChild ?? null);
  }
  danmakuButton = button;
  installEnterKeyHandler(options.canSubmit, options.onSubmit);
}

function setDanmakuButtonBusy(busy: boolean): void {
  isDanmakuButtonBusy = busy;
  if (danmakuButton) {
    danmakuButton.disabled = busy;
    danmakuButton.classList.toggle("is-busy", busy);
    danmakuButton.setAttribute("aria-busy", busy ? "true" : "false");
  }
}

export function updateDanmakuButtonLanguage(): void {
  if (danmakuButton) {
    updateDanmakuButtonText(danmakuButton);
  }
}

function updateDanmakuButtonText(button: HTMLButtonElement): void {
  button.textContent = t("danmakuButton");
  button.title = t("danmakuButtonTitle");
  button.setAttribute("aria-label", t("danmakuButtonAriaLabel"));
}

export function setOverlayFontScale(scale: number): void {
  if (!Number.isFinite(scale)) {
    return;
  }
  overlayFontScale = Math.min(1.6, Math.max(0.6, scale));
  applyFontScale(overlayContainer);
}

export function showDanmakuNotice(message: string, context: OverlayContext): void {
  const overlay = ensureOverlay();
  if (!overlay.isConnected && context.activeVideo) {
    attachOverlay(context.activeVideo);
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

export function flashDanmakuUnavailable(message: string, context: OverlayContext): void {
  if (isDanmakuButtonBusy) {
    return;
  }
  showDanmakuNotice(message, context);
  if (danmakuButtonBusyTimer !== undefined) {
    window.clearTimeout(danmakuButtonBusyTimer);
  }
  setDanmakuButtonBusy(true);
  danmakuButtonBusyTimer = window.setTimeout(() => {
    setDanmakuButtonBusy(false);
    danmakuButtonBusyTimer = undefined;
  }, NOTICE_DURATION_MS);
}

export const OVERLAY_BASE_LANE_HEIGHT = BULLET_LANE_HEIGHT;
export const OVERLAY_WAVE_DELAY_MS = BULLET_WAVE_DELAY_MS;

function renderTimelineMarkers(
  container: HTMLDivElement,
  data: { videoId: string; seconds: number[]; duration: number }
): void {
  timelinePendingData = data;
  const fragment = document.createDocumentFragment();
  data.seconds.forEach(second => {
    const marker = document.createElement("div");
    marker.className = "myz-danmaku-progress-marker";
    const percent = (second / data.duration) * 100;
    marker.style.left = `${Math.min(100, Math.max(0, percent))}%`;
    fragment.appendChild(marker);
  });
  container.innerHTML = "";
  container.appendChild(fragment);
}

export function updateTimelineIndicators(
  video: HTMLVideoElement | null,
  videoId: string | null,
  entries: DanmakuEntry[]
): void {
  if (!videoId || !video || !Number.isFinite(video.duration) || video.duration <= 0) {
    clearTimelineMarkers();
    return;
  }
  const duration = video.duration;
  const uniqueSeconds = new Set<number>();
  entries.forEach(entry => {
    if (typeof entry.seconds !== "number" || !Number.isFinite(entry.seconds)) {
      return;
    }
    const clamped = Math.min(duration, Math.max(0, entry.seconds));
    uniqueSeconds.add(Math.floor(clamped));
  });
  const sortedSeconds = Array.from(uniqueSeconds).sort((a, b) => a - b);
  if (sortedSeconds.length === 0) {
    timelinePendingData = null;
    const container = ensureTimelineContainer();
    if (container) {
      container.innerHTML = "";
    }
    return;
  }
  const data = { videoId, seconds: sortedSeconds, duration };
  timelinePendingData = data;
  const container = ensureTimelineContainer();
  if (!container) {
    scheduleTimelineRetry();
    return;
  }
  clearTimelineRetry();
  renderTimelineMarkers(container, data);
}
