import Innertube, { ClientType, YT as YTNamespace, YTNodes, Misc, UniversalCache } from "youtubei.js/web";
import type { DanmakuEntry } from "../shared/danmaku";

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

type RequestTask = {
  execute: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
};

const COMMENT_SORT_ORDERS = ["TOP_COMMENTS", "NEWEST_FIRST"] as const;
const DEFAULT_MAX_FETCH_PAGES = 30;
const REQUEST_LIMIT = 10;
const REQUEST_INTERVAL_MS = 5_000;
const MAX_CONCURRENT_REQUESTS = 2;

let innertubePromise: Promise<Innertube> | null = null;
const requestQueue: RequestTask[] = [];
let requestsInFlight = 0;
let requestsStartedInWindow = 0;
let windowStart = 0;
let queueTimer: number | undefined;

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

const LINE_TIMESTAMP_PATTERN = "([0-9]{1,2}:\\d{2}:\\d{2}|\\d{1,4}:\\d{2})";

export type TimestampedLine = { seconds: number; content: string };

export function splitMultiLineTimestampComment(text: string): TimestampedLine[] | null {
  if (!text || !text.includes("\n")) {
    return null;
  }
  const lines = text.split(/\r?\n/);
  const segments: Array<{ seconds: number; content: string }> = [];
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.length === 0) {
      continue;
    }
    const startPattern = new RegExp(`^${LINE_TIMESTAMP_PATTERN}\\s+(.*)$`);
    const endPattern = new RegExp(`^(.*\\S)\\s+${LINE_TIMESTAMP_PATTERN}$`);
    let timeText: string | null = null;
    let remainder: string | null = null;
    let match: RegExpMatchArray | null = line.match(startPattern);
    if (match) {
      timeText = match[1];
      remainder = match[2];
    } else {
      match = line.match(endPattern);
      if (match) {
        remainder = match[1];
        timeText = match[2];
      }
    }
    if (!timeText || !remainder || remainder.trim().length === 0) {
      continue;
    }
    const seconds = parseColonTimestamp(timeText);
    if (seconds === null) {
      continue;
    }
    segments.push({ seconds, content: line });
  }
  return segments.length >= 2 ? segments : null;
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
  const multiLineSegments = splitMultiLineTimestampComment(comment.text);
  if (multiLineSegments) {
    let added = 0;
    multiLineSegments.forEach(({ seconds, content }) => {
      const entryId = makeEntryId(comment.id, seconds);
      if (seen.has(entryId)) {
        return;
      }
      seen.add(entryId);
      bucket.push({
        id: entryId,
        videoId,
        content,
        seconds,
        author: comment.author,
        publishedText: comment.published,
        likeCount: comment.likeCount,
        isPinned: comment.isPinned
      });
      added += 1;
    });
    return added;
  }

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

function commentNodeFromThread(thread: YTNodes.CommentThread | null | undefined): CommentNode | null {
  if (!thread || !(thread instanceof YTNodes.CommentThread)) {
    return null;
  }
  return thread.comment ?? null;
}

function gatherRepliesFromThread(thread: YTNodes.CommentThread): CommentNode[] {
  const replies: CommentNode[] = [];
  thread.replies?.forEach(reply => {
    const comment = commentNodeFromThread(reply);
    if (comment) {
      replies.push(comment);
    }
  });
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
      await enqueueRequest(() => thread.getReplies());
      gatherRepliesFromThread(thread).forEach(reply => emit(reply));
    } catch (error) {
      console.warn("MyZ Danmaku: failed to load replies", error);
    }

    try {
      let hasMore = false;
      try {
        hasMore = thread.has_continuation;
      } catch {
        hasMore = false;
      }
      while (hasMore) {
        const continuation = await enqueueRequest(() => thread.getContinuation());
        continuation.replies.forEach(reply => emit(commentNodeFromThread(reply)));
        hasMore = continuation.has_continuation;
      }
    } catch (error) {
      console.warn("MyZ Danmaku: failed to load replies continuation", error);
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
      cache: new UniversalCache(false)
    });
  }
  return innertubePromise;
}

export async function loadDanmakuFromInnertube(
  videoId: string,
  onBatch?: (entries: DanmakuEntry[]) => Promise<void> | void,
  options: { maxPages?: number } = {}
): Promise<DanmakuEntry[]> {
  const maxPages = Math.max(1, options.maxPages ?? DEFAULT_MAX_FETCH_PAGES);
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

    while (page && pageIndex < maxPages) {
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
