import { Cover } from '@rezics/ui/cover';
import { Button } from '@rezics/ui/shadcn/button';
import { ChevronRight, Search, X } from 'lucide-react';
import { m } from '../paraglide/messages.js';
import { getLocale, locales } from '../paraglide/runtime.js';
import { coverSrc } from '../media/cover-src';
import { useSession } from '../session/query';
import { useCallback, useState } from 'react';
import {
  recentBucket,
  recentSearchQuery,
  type RecentEntry as HistoryEntry,
  type RecentHistory,
  type RecentHistoryOwner,
} from './recent-history';
import { useRecentHistory } from './recent-history-hook';
import { useHistoryRemovalFocus } from './history-removal-focus';
import type { KernelClient } from '@rezics/client';
import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { admitRecentCursor, admitRecentWrite } from './recent-request';
export type RecentEntry = Parameters<KernelClient['recentSearches']['post']>[0]['entry'];
export type RecentPage = NonNullable<Awaited<ReturnType<KernelClient['recentSearches']['get']>>['data']>;
export type RecentItem = RecentPage['recentSearches'][number];
export type Change = { kind: 'use'; entry: RecentEntry } | { kind: 'remove'; id: string } | { kind: 'clear' };
export type Pending = { key: string; change: Change; queuedAt: string };
export type LocalRecent = { revision: number; entries: RecentItem[]; pending: Pending[] };
/** Compatibility helpers for existing pure fixtures; production persists only recent-history.ts. */
export const RECENT_STORAGE = 'rezics.search-history.v1:';
const lifetime = 90 * 86400000;
export const emptyRecent = (): LocalRecent => ({ revision: 0, entries: [], pending: [] });
export const entryKey = (entry: RecentEntry) => JSON.stringify(entry);
const queryDisplay = (text: string, languages?: readonly string[]) => {
  const params = recentSearchQuery(text, languages);
  return { name: text, href: `/search${params ? `?${params}` : ''}`, avatar: null };
};
export function localChange(
  state: LocalRecent,
  change: Change,
  signedIn: boolean,
  now = new Date(),
  inFlight?: string,
): LocalRecent {
  let entries = state.entries.filter((item) => Date.parse(item.lastUsed) > now.getTime() - lifetime);
  let pending = [...state.pending];
  if (change.kind === 'use') {
    const entry = change.entry;
    const existing = entries.find((item) => entryKey(item.entry) === entryKey(entry));
    entries = [
      {
        id: existing?.id ?? `local:${crypto.randomUUID()}`,
        entry: change.entry,
        revision: state.revision,
        lastUsed: now.toISOString(),
        display:
          change.entry.kind === 'query'
            ? queryDisplay(change.entry.text, change.entry.languages)
            : (existing?.display ?? null),
      },
      ...entries.filter((item) => entryKey(item.entry) !== entryKey(entry)),
    ].slice(0, 100);
  } else if (change.kind === 'remove') {
    const id = change.id;
    const removed = entries.find((item) => item.id === id);
    entries = entries.filter((item) => item.id !== id);
    if (change.id.startsWith('local:') && removed) {
      const sending = pending.find(
        (p) => p.key === inFlight && p.change.kind === 'use' && entryKey(p.change.entry) === entryKey(removed.entry),
      );
      pending = pending.filter(
        (p) => p.key === inFlight || p.change.kind !== 'use' || entryKey(p.change.entry) !== entryKey(removed.entry),
      );
      if (!sending) return { ...state, entries, pending };
      change = { kind: 'remove', id: `pending:${sending.key}` };
    }
  } else entries = [];
  if (signedIn) {
    if (pending.length >= 100) throw new Error('Recent queue is full');
    pending.push({ key: crypto.randomUUID(), change, queuedAt: now.toISOString() });
  }
  return { ...state, entries, pending };
}
/** Persist references only for scopes. Current private names and avatars never survive in browser storage. */
export function savedRecent(state: LocalRecent): string {
  return JSON.stringify({
    ...state,
    entries: state.entries.map((item) => ({ ...item, display: item.entry.scope ? null : item.display })),
  });
}
export function restoreRecent(value: string | null, now = Date.now()): LocalRecent {
  if (!value || value.length > 262144) return emptyRecent();
  try {
    const state = JSON.parse(value) as LocalRecent;
    const text = (value: unknown, max: number) => typeof value === 'string' && value.length > 0 && value.length <= max;
    const bounded = <T,>(items: T[], max: number, valid: (item: T) => boolean) =>
      Array.isArray(items) && items.length <= max && items.every(valid);
    const validEntry = (entry: RecentEntry): boolean => {
      if (entry?.kind === 'query')
        return (
          text(entry.text, 256) &&
          (entry.languages === undefined ||
            bounded(
              entry.languages,
              8,
              (language) => text(language, 35) && /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(language),
            ))
        );
      if (entry?.kind !== 'scope' || !entry.scope) return false;
      const scope = entry.scope;
      return scope.kind === 'route'
        ? scope.route === 'library'
        : ['realm', 'collection'].includes(scope.kind) && /^[0-9a-f-]{36}$/.test(scope.id);
    };
    const validItem = (i: RecentItem) =>
      validEntry(i.entry) && text(i.id, 80) && Number.isFinite(Date.parse(i.lastUsed));
    const validPending = (p: Pending) =>
      text(p.key, 80) &&
      !!p.change &&
      Number.isFinite(Date.parse(p.queuedAt)) &&
      (p.change.kind === 'use'
        ? validEntry(p.change.entry)
        : p.change.kind === 'clear' || (p.change.kind === 'remove' && text(p.change.id, 80)));
    if (
      !Number.isInteger(state.revision) ||
      state.revision < 0 ||
      !bounded(state.entries, 100, validItem) ||
      !bounded(state.pending, 100, validPending)
    )
      return emptyRecent();
    return {
      ...state,
      pending: state.pending.filter((p) => Date.parse(p.queuedAt) > now - lifetime),
      entries: state.entries
        .filter((i) => Date.parse(i.lastUsed) > now - lifetime)
        .map((i) => ({
          ...i,
          display: i.entry.kind === 'query' && !i.entry.scope ? queryDisplay(i.entry.text) : null,
        })),
    };
  } catch {
    return emptyRecent();
  }
}
async function authenticatedRecent() {
  const { env } = await import('cloudflare:workers');
  const { prepareSession, sessionSubject, viewerCredential } = await import('../session/request');
  const request = getRequest();
  setResponseHeader('Cache-Control', 'private, no-store');
  await prepareSession(request, env);
  const accountId = sessionSubject(request),
    authorization = viewerCredential(request);
  if (!accountId || !authorization) return null;
  // This personal resource always uses the configured BFF transport; development fixtures cannot grant sync.
  if (!(env as { KERNEL_ORIGIN?: string }).KERNEL_ORIGIN) throw new Error('KERNEL_ORIGIN is required for recent sync');
  const { kernelClient } = await import('../kernel/client');
  return { accountId, authorization, api: kernelClient() };
}
export const readRecent = createServerFn({ method: 'GET' })
  .validator(admitRecentCursor)
  .handler(async ({ data: cursor }) => {
    const auth = await authenticatedRecent();
    if (!auth) return { accountId: null, page: null };
    const result = await auth.api.recentSearches.get({
      query: { limit: 20, ...(cursor ? { cursor } : {}) },
      headers: { authorization: auth.authorization },
      fetch: { cache: 'no-store', signal: getRequest().signal },
    });
    if (result.error || !result.data) {
      const failure = result.error?.value;
      return {
        accountId: auth.accountId,
        page: null,
        code:
          failure && typeof failure === 'object' && 'code' in failure && typeof failure.code === 'string'
            ? failure.code
            : 'unavailable',
      };
    }
    return { accountId: auth.accountId, page: result.data };
  });
export const writeRecent = createServerFn({ method: 'POST' })
  .validator(admitRecentWrite)
  .handler(async ({ data }) => {
    const auth = await authenticatedRecent();
    if (!auth || auth.accountId !== data.accountId) return { ok: false as const, code: 'forbidden' };
    const headers = { authorization: auth.authorization, 'idempotency-key': JSON.stringify(data.pending.key) },
      fetch = { signal: getRequest().signal },
      change = data.pending.change;
    const result =
      change.kind === 'use'
        ? await auth.api.recentSearches.post(
            { entry: change.entry, expectedRevision: data.expectedRevision },
            { headers, fetch },
          )
        : change.kind === 'clear'
          ? await auth.api.recentSearches.$clear.post({ expectedRevision: data.expectedRevision }, { headers, fetch })
          : await auth.api
              .recentSearches({ id: change.id })
              .delete(undefined, { query: { expectedRevision: data.expectedRevision }, headers, fetch });
    if (result.error || !result.data) {
      const failure = result.error?.value;
      return {
        ok: false as const,
        code:
          failure && typeof failure === 'object' && 'code' in failure && typeof failure.code === 'string'
            ? failure.code
            : 'unavailable',
      };
    }
    return { ok: true as const, value: result.data };
  });
export type RecentState = 'loading' | 'local' | 'ready' | 'unavailable' | 'conflict';
/** Both consumers use the delivered bucketed local helper and its own-account adapter. */
export function useRecentSearches(): RecentHistory {
  const session = useSession();
  return useRecentHistory(recentBucket(session.state, session.subject));
}
/** Render local entries without inventing an available scoped destination. */
function historyItem(entry: HistoryEntry): RecentItem {
  const ref = entry.scope;
  const scope =
    ref?.kind === 'Library'
      ? { kind: 'route' as const, route: 'library' as const }
      : { kind: ref?.kind === 'Realm' ? ('realm' as const) : ('collection' as const), id: ref?.id ?? '' };
  const native: RecentEntry = ref
    ? entry.query
      ? {
          kind: 'query',
          text: entry.query,
          ...(entry.languages !== undefined ? { languages: [...entry.languages] } : {}),
          scope,
        }
      : { kind: 'scope', scope }
    : {
        kind: 'query',
        text: entry.query,
        ...(entry.languages !== undefined ? { languages: [...entry.languages] } : {}),
      };
  const action = ref?.searchAction;
  const base = ref
    ? action?.startsWith('/') && !action.startsWith('//') && !/[\\\r\n]/.test(action)
      ? action
      : undefined
    : '/search';
  let href: string | undefined;
  if (base) {
    const destination = new URL(base, 'https://recent-history.invalid');
    destination.pathname = destination.pathname.replace(new RegExp(`^/(${locales.join('|')})(?=/)`), '');
    const retained = new URLSearchParams(destination.search);
    retained.delete('q');
    retained.delete('cursor');
    retained.delete('language');
    const params = [recentSearchQuery(entry.query, entry.languages), retained.toString()].filter(Boolean).join('&');
    href = `${destination.pathname}${params ? `?${params}` : ''}`;
  }
  return {
    id: entry.id,
    entry: native,
    revision: 0,
    lastUsed: new Date(entry.visitedAt).toISOString(),
    display: href ? { name: ref?.name ?? entry.query, href, avatar: null } : null,
  };
}
type NativeViewProps = {
  owner?: RecentHistoryOwner;
  entries: RecentItem[];
  status: RecentState;
  onRemove(id: string): void;
  onClear?(): void;
  onReload?(): void;
  history?: boolean;
  onMore?(): void;
  next?: string | null;
};
export function RecentHistoryView(props: NativeViewProps | (RecentHistory & { history?: boolean })) {
  const local = 'persistence' in props ? props : undefined;
  const native = 'status' in props ? props : undefined;
  const entries = local ? local.entries.map(historyItem) : native!.entries;
  const status: RecentState = local
    ? (local.failure ?? (local.sync === 'pending' ? 'loading' : 'local'))
    : native!.status;
  const onRemove = local?.remove ?? native!.onRemove;
  const onClear = local?.clear ?? native?.onClear;
  const onReload = local?.retry ?? native?.onReload;
  const history = props.history ?? false,
    onMore = native?.onMore,
    next = native?.next;
  const locale = getLocale();
  const [announcement, setAnnouncement] = useState('');
  const announce = useCallback((message: string) => setAnnouncement(message), []);
  const visibleEntries = entries.slice(0, history ? 100 : 5);
  const focus = useHistoryRemovalFocus(entries, visibleEntries, announce, props.owner);
  return (
    <section
      ref={focus.regionRef}
      tabIndex={-1}
      className="space-y-2 px-3 py-3"
      aria-label={history ? m.search_history() : m.search_recent()}
    >
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">{history ? m.search_history() : m.search_recent()}</h2>
        {history ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={(event) => {
              if (!onClear) return;
              focus.requestClear(event.currentTarget, m.search_history_management_cleared());
              onClear();
            }}
            disabled={!entries.length}
          >
            {m.search_history_clear()}
          </Button>
        ) : (
          <a href={`/${locale}/search/history`} className="flex items-center text-sm text-muted-foreground">
            {m.search_history()}
            <ChevronRight aria-hidden="true" className="size-4" />
          </a>
        )}
      </div>
      {status === 'loading' && <p role="status">{m.header_search_loading()}</p>}
      {(status === 'unavailable' || status === 'conflict') && (
        <p role="status" className="text-sm text-muted-foreground">
          {status === 'conflict' ? m.search_history_conflict() : m.search_history_offline()}
          {onReload && (
            <Button type="button" variant="ghost" size="sm" onClick={onReload}>
              {m.search_history_reload()}
            </Button>
          )}
        </p>
      )}
      {!entries.length && status !== 'loading' && (
        <p className="text-sm text-muted-foreground">{m.search_history_empty()}</p>
      )}
      <p className="sr-only" role="status" aria-live="polite">
        {announcement}
      </p>
      <ul ref={focus.listRef}>
        {visibleEntries.map((item, index) => {
          const name =
            item.entry.kind === 'query'
              ? item.entry.text
              : item.entry.scope.kind === 'route' && item.display
                ? m.nav_library()
                : (item.display?.name ?? m.search_history_unavailable());
          const href = item.display ? `/${locale}${item.display.href}` : undefined;
          const Tag = href ? 'a' : 'span';
          return (
            <li key={item.id} className="flex min-w-0 items-center gap-1 rounded-xl hover:bg-accent">
              <Tag href={href} className="flex min-w-0 flex-1 items-center gap-3 rounded-xl px-2 py-2">
                <span className="grid size-8 shrink-0 place-items-center overflow-hidden rounded-full bg-muted">
                  {item.display?.avatar ? (
                    <Cover
                      subject={{ id: item.id, title: name, types: [] }}
                      cover={item.display.avatar}
                      size="xs"
                      ratio="1:1"
                      src={coverSrc}
                      decorative
                    />
                  ) : (
                    <Search aria-hidden="true" className="size-4 text-muted-foreground" />
                  )}
                </span>
                <span className="min-w-0 text-sm">
                  <span className="block truncate">{name}</span>
                  {item.entry.kind === 'query' && item.entry.scope && (
                    <span className="block truncate text-xs text-muted-foreground">
                      {item.display?.name || m.search_history_unavailable()}
                    </span>
                  )}
                </span>
              </Tag>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                aria-label={m.search_history_remove({ name })}
                data-history-action=""
                data-history-id={item.id}
                onClick={(event) => {
                  focus.requestRemove(
                    item.id,
                    index,
                    event.currentTarget,
                    m.search_history_management_removed({ name }),
                  );
                  onRemove(item.id);
                }}
              >
                <X aria-hidden="true" className="size-4" />
              </Button>
            </li>
          );
        })}
      </ul>
      {history && next && (
        <Button type="button" variant="outline" onClick={onMore}>
          {m.search_more()}
        </Button>
      )}
    </section>
  );
}
export function SearchHistoryPage() {
  const recent = useRecentSearches();
  return (
    <div className="mx-auto max-w-3xl">
      <RecentHistoryView {...recent} history />
    </div>
  );
}
