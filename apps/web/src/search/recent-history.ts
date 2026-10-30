import type { SearchScope } from './header-search/types';

export const RECENT_HISTORY_LIMIT = 32;
export type RecentEntry = { id: string; query: string; scope?: SearchScope; visitedAt: number };
export type RecentStorage = Pick<Storage, 'getItem' | 'setItem'>;
/** Own-account transport; local history remains the sole producer and store. */
export type RecentSyncAdapter = { sync(entries: readonly RecentEntry[], signal: AbortSignal): Promise<void> };
export type RecentHistory = {
  entries: readonly RecentEntry[];
  persistence: 'local' | 'memory' | 'unavailable';
  sync: 'local-only' | 'pending' | 'synced';
  failure?: 'unavailable' | 'conflict';
  clear?(): void;
  retry?(): void;
  remember(query: string, scope?: SearchScope): void;
  remove(id: string): void;
};
export function recentBucket(state: string, subject?: string | null): string | null {
  return state === 'signed-out' ? 'anonymous' : state === 'signed-in' && subject ? `account:${subject}` : null;
}
export const recentHistoryKey = (bucket: string) => `rezics.search-history.v1:${encodeURIComponent(bucket)}`;
const kinds = new Set(['Library', 'Collection', 'Realm', 'Zone', 'Agent']);
function cleanScope(raw: unknown): SearchScope | undefined {
  if (!raw || typeof raw !== 'object') return;
  const value = raw as Record<string, unknown>;
  if (!kinds.has(String(value.kind)) || typeof value.id !== 'string' || typeof value.name !== 'string') return;
  const action = value.searchAction;
  const image = value.image;
  return {
    kind: value.kind as SearchScope['kind'],
    id: value.id.slice(0, 256),
    name: value.name.slice(0, 256),
    ...(typeof action === 'string' && action.startsWith('/') && !action.startsWith('//') && !/[\\\r\n]/.test(action)
      ? { searchAction: action.slice(0, 2048) }
      : {}),
    ...(typeof image === 'string' && image.startsWith('/media/') ? { image: image.slice(0, 2048) } : {}),
  };
}
export function readRecentHistory(storage: RecentStorage, bucket: string): RecentEntry[] {
  const serialized = storage.getItem(recentHistoryKey(bucket));
  try {
    const parsed = JSON.parse(serialized ?? '[]');
    const raw: unknown = Array.isArray(parsed) ? parsed : parsed?.entries;
    if (!Array.isArray(raw)) return [];
    return raw.slice(0, RECENT_HISTORY_LIMIT).flatMap((item) => {
      if (
        !item ||
        typeof item !== 'object' ||
        typeof item.query !== 'string' ||
        typeof item.visitedAt !== 'number' ||
        !Number.isFinite(item.visitedAt)
      )
        return [];
      const scope = cleanScope(item.scope);
      // Corrupt scoped history must never silently become global history.
      if (item.scope && !scope) return [];
      const query = item.query.slice(0, 256);
      if (!query.trim() && !scope) return [];
      return [{ id: recentId(query, scope), query, ...(scope ? { scope } : {}), visitedAt: item.visitedAt }];
    });
  } catch {
    return [];
  }
}
export function recentId(query: string, scope?: SearchScope) {
  return JSON.stringify([scope?.kind ?? null, scope?.id ?? null, query]);
}
export function rememberRecent(
  entries: readonly RecentEntry[],
  query: string,
  scope?: SearchScope,
  now = Date.now(),
): RecentEntry[] {
  query = query.slice(0, 256);
  if (!query.trim() && !scope) return [...entries];
  const safeScope = cleanScope(scope);
  if (scope && !safeScope) return [...entries];
  const id = recentId(query, safeScope);
  return [
    { id, query, ...(safeScope ? { scope: safeScope } : {}), visitedAt: now },
    ...entries.filter((entry) => entry.id !== id),
  ].slice(0, RECENT_HISTORY_LIMIT);
}
export function writeRecentHistory(storage: RecentStorage, bucket: string, entries: readonly RecentEntry[]): boolean {
  try {
    const document = readRecentDocument(storage, bucket);
    writeRecentDocument(storage, bucket, { ...document, entries: [...entries] });
    return true;
  } catch {
    return false;
  }
}

/** Queue metadata shares the delivered history key; old array values remain readable. */
export type RecentDocument = {
  entries: RecentEntry[];
  removed: string[];
  clear?: string;
  native?: unknown;
};
export function readRecentDocument(storage: RecentStorage, bucket: string): RecentDocument {
  const entries = readRecentHistory(storage, bucket);
  try {
    const raw = JSON.parse(storage.getItem(recentHistoryKey(bucket)) ?? '[]');
    return {
      entries,
      removed: Array.isArray(raw?.removed)
        ? raw.removed.filter((id: unknown) => typeof id === 'string').slice(0, 100)
        : [],
      ...(typeof raw?.clear === 'string' ? { clear: raw.clear } : {}),
      ...(raw?.native ? { native: raw.native } : {}),
    };
  } catch {
    return { entries, removed: [] };
  }
}
export function writeRecentDocument(storage: RecentStorage, bucket: string, document: RecentDocument): void {
  const entries = document.entries.slice(0, RECENT_HISTORY_LIMIT).map((entry) => {
    // Account scope labels/actions must be hydrated again; browser history is never their authority.
    if (bucket.startsWith('account:') && entry.scope)
      return { ...entry, scope: { kind: entry.scope.kind, id: entry.scope.id, name: '' } };
    return entry;
  });
  storage.setItem(recentHistoryKey(bucket), JSON.stringify({ ...document, entries }));
}
