/** Dependency-free Recent Search vocabulary: native request/result, journal, errors and host capabilities. */

export const RECENT_HISTORY_CHANGED = 'rezics-search-history-changed';
export const RECENT_NATIVE_REVISION_MAX = 2_147_483_646;
export const RECENT_NATIVE_QUERY_TEXT_LIMIT = 256;
export const RECENT_HISTORY_LIMIT = 32;
export const RECENT_QUEUE_LIMIT = 100;
export const RECENT_LIFETIME_MS = 90 * 86_400_000;

export type RecentNativeScope =
  | { kind: 'realm'; id: string }
  | { kind: 'collection'; id: string }
  | { kind: 'route'; route: 'library' };

export type RecentNativeEntry =
  | {
      kind: 'query';
      text: string;
      languages?: string[];
      scope?: RecentNativeScope;
    }
  | { kind: 'scope'; scope: RecentNativeScope };

export type RecentNativeCover = {
  media: string;
  width: number;
  height: number;
  placeholder: { thumbhash: string; color: string };
  variants: { format: 'avif' | 'webp'; width: number }[];
  focalPoint: { x: number; y: number } | null;
  credit: {
    rightsHolder: string;
    via: { name: string; url: string };
    license: string;
    obligations: string[];
  };
};

export type RecentNativeItem = {
  id: string;
  lastUsed: string;
  revision: number;
  entry: RecentNativeEntry;
  display: { name: string; href: string; avatar: RecentNativeCover | null } | null;
};

export type RecentNativePage = {
  recentSearches: RecentNativeItem[];
  next: string | null;
  revision: number;
};

export type RecentChange =
  | { kind: 'use'; entry: RecentNativeEntry }
  | { kind: 'remove'; id: string }
  | { kind: 'clear' };

export type RecentPending = { key: string; change: RecentChange; queuedAt: string };

export type RecentWrite = { accountId: string; expectedRevision: number; pending: RecentPending };

export type RecentRetryDeadline = number;
export type RecentRetryAdmission = { retryAt?: RecentRetryDeadline };

export type RecentReadResult = {
  accountId: string | null;
  page: RecentNativePage | null;
  code?: string;
} & RecentRetryAdmission;

export type RecentWriteResult =
  | ({ ok: false; code: string } & RecentRetryAdmission)
  | { ok: true; value: { id: string | null; revision: number; lastUsed: string } };

export type RecentSearchTransport = {
  read(cursor: string | undefined, signal: AbortSignal): Promise<RecentReadResult>;
  write(input: RecentWrite, signal: AbortSignal): Promise<RecentWriteResult>;
};

export type RecentSyncFailure = 'unavailable' | 'conflict';

export class RecentSyncError extends Error {
  constructor(readonly code: RecentSyncFailure) {
    super(code);
    this.name = 'RecentSyncError';
  }
}

export type QueuedRecentCommand = RecentPending & {
  localId?: string;
  visitedAt?: number;
  expectedRevision?: number;
};

export type RecentJournal = {
  revision: number | null;
  observed: Record<string, number>;
  rows: Record<string, { id: string; visitedAt: number; entry?: RecentNativeEntry }>;
  pending: QueuedRecentCommand[];
  conflict?: boolean;
};

export type RecentSessionState = 'unknown' | 'signed-in' | 'signed-out' | 'unavailable';

export type RecentSessionView = {
  state: RecentSessionState;
  subject: string | null;
  csrfToken: string | null;
  anonymous: boolean;
  incarnation: object;
  sessionKey: string | null;
};

export type RecentSearchHost = {
  readSession(): RecentSessionView;
  observeSession(notify: () => void): () => void;
  observeRetirement(retire: () => void): () => void;
  observeStorage(listener: (event: StorageEvent) => void): () => void;
  now(): number;
  createId(): string;
  transport: RecentSearchTransport;
};

export function recentSearchSessionKey(session: {
  state: string;
  subject?: string | null;
  csrfToken: string | null;
}): string | null {
  if (session.state === 'signed-out') return JSON.stringify(['signed-out']);
  if (session.state !== 'signed-in' || !session.subject) return null;
  return JSON.stringify(['signed-in', session.subject, session.csrfToken]);
}

export function recentSearchBucket(state: string, subject?: string | null): string | null {
  return state === 'signed-out' ? 'anonymous' : state === 'signed-in' && subject ? `account:${subject}` : null;
}

export const freshRecentJournal = (): RecentJournal => ({ revision: null, observed: {}, rows: {}, pending: [] });
