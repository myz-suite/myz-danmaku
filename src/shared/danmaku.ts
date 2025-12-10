export interface DanmakuEntry {
  id: string;
  videoId: string;
  content: string;
  seconds: number;
  author: string;
  publishedText: string;
  likeCount: number;
  isPinned: boolean;
}

export interface CachedDanmakuPayload {
  storedAt: number;
  entries: DanmakuEntry[];
}

export interface CachedDanmakuRecord extends CachedDanmakuPayload {
  videoId: string;
}
