import { useContext, useEffect, useSyncExternalStore } from 'react';
import { QueryClientContext } from '@tanstack/react-query';
import { Cover } from '@rezics/ui/cover';
import { Button } from '@rezics/ui/shadcn/button';
import { ChevronRight, Search, X } from 'lucide-react';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { coverSrc } from '../media/cover-src';
import { useSession, sessionCsrfToken } from '../session/query';
import type { SpacePageData } from '../community/space';
import type { KernelClient } from '@rezics/client';
import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
export type RecentEntry = Parameters<KernelClient['recentSearches']['post']>[0]['entry'];
export type RecentPage = NonNullable<Awaited<ReturnType<KernelClient['recentSearches']['get']>>['data']>;
export type RecentItem = RecentPage['recentSearches'][number];
export type Change = { kind: 'use'; entry: RecentEntry } | { kind: 'remove'; id: string } | { kind: 'clear' };
export type Pending = { key: string; change: Change; queuedAt: string };
export type LocalRecent = { revision: number; entries: RecentItem[]; pending: Pending[] };
export const RECENT_STORAGE = 'rezics:recent:v1:';
const lifetime = 90 * 86400000;
export const emptyRecent = (): LocalRecent => ({ revision: 0, entries: [], pending: [] });
export const entryKey = (entry: RecentEntry) => JSON.stringify(entry);
const queryDisplay = (text: string) => ({ name: text, href: `/search?q=${encodeURIComponent(text)}`, avatar: null });
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
        display: change.entry.kind === 'query' ? queryDisplay(change.entry.text) : (existing?.display ?? null),
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
    entries: state.entries.map((item) => ({ ...item, display: item.entry.kind === 'scope' ? null : item.display })),
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
        return text(entry.text, 256) && (!entry.languages || bounded(entry.languages, 8, (l) => text(l, 35)));
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
          display: i.entry.kind === 'query' ? queryDisplay(i.entry.text) : null,
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
  .validator((cursor: string | undefined) => cursor)
  .handler(async ({ data: cursor }) => {
    const auth = await authenticatedRecent();
    if (!auth) return { accountId: null, page: null };
    const result = await auth.api.recentSearches.get({
      query: { limit: 20, ...(cursor ? { cursor } : {}) },
      headers: { authorization: auth.authorization },
      fetch: { cache: 'no-store' },
    });
    if (result.error || !result.data) return { accountId: auth.accountId, page: null };
    return { accountId: auth.accountId, page: result.data };
  });
export const writeRecent = createServerFn({ method: 'POST' })
  .validator((input: { accountId: string; expectedRevision: number; pending: Pending }) => input)
  .handler(async ({ data }) => {
    const auth = await authenticatedRecent();
    if (!auth || auth.accountId !== data.accountId) return { ok: false as const, code: 'forbidden' };
    const headers = { authorization: auth.authorization, 'idempotency-key': JSON.stringify(data.pending.key) },
      change = data.pending.change;
    const result =
      change.kind === 'use'
        ? await auth.api.recentSearches.post(
            { entry: change.entry, expectedRevision: data.expectedRevision },
            { headers },
          )
        : change.kind === 'clear'
          ? await auth.api.recentSearches.$clear.post({ expectedRevision: data.expectedRevision }, { headers })
          : await auth.api
              .recentSearches({ id: change.id })
              .delete(undefined, { query: { expectedRevision: data.expectedRevision }, headers });
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
const marker = `${RECENT_STORAGE}account`;
type Snapshot = { data: LocalRecent; status: RecentState; next: string | null; accountId: string | null };
const initial: Snapshot = { data: emptyRecent(), status: 'loading', next: null, accountId: null };
// One browser coordinator serves the shared input and History page. No personal state is populated during SSR.
let snapshot = initial,
  session = 'unknown',
  sessionOwner: string | null = null,
  generation = 0,
  busy = -1,
  inFlight: string | undefined;
let requested = false,
  lastVisit = '';
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};
function update(value: Partial<Snapshot>) {
  snapshot = { ...snapshot, ...value };
  for (const listener of listeners) listener();
}
function save(data: LocalRecent) {
  update({ data });
  try {
    localStorage.setItem(RECENT_STORAGE + (snapshot.accountId ?? 'anonymous'), savedRecent(data));
  } catch {
    /* Storage is optional. */
  }
}
function hideScopes() {
  update({
    data: {
      ...snapshot.data,
      entries: snapshot.data.entries.map((item) => (item.entry.kind === 'scope' ? { ...item, display: null } : item)),
    },
  });
}
function fail(status: RecentState = 'unavailable') {
  hideScopes();
  update({ status });
}
function accept(page: RecentPage) {
  save({ revision: page.revision, entries: page.recentSearches, pending: [] });
  update({ next: page.next, status: 'ready' });
}
function changeRecent(change: Change) {
  if (session !== 'signed-in' && session !== 'signed-out') return;
  try {
    if (session === 'signed-in' && !snapshot.accountId) {
      update({ data: localChange(snapshot.data, change, true) });
      return;
    }
    save(localChange(snapshot.data, change, !!snapshot.accountId, new Date(), inFlight));
    requested = true;
    void synchronize();
  } catch {
    update({ status: 'unavailable' });
  }
}
async function synchronize() {
  if (session !== 'signed-in' || busy === generation) return;
  const run = generation,
    live = () => generation === run;
  busy = run;
  requested = false;
  hideScopes();
  let succeeded = false;
  try {
    const result = await readRecent({ data: undefined });
    if (!live()) return;
    if (!result.accountId || (sessionOwner && result.accountId !== sessionOwner)) return fail();
    if (snapshot.accountId !== result.accountId) {
      const provisional = snapshot.accountId ? [] : snapshot.data.pending;
      update({ accountId: result.accountId });
      let restored = emptyRecent();
      try {
        restored = restoreRecent(localStorage.getItem(RECENT_STORAGE + result.accountId));
        localStorage.setItem(marker, result.accountId);
      } catch {
        /* Memory remains usable. */
      }
      if (!restored.pending.length && result.page)
        restored = { revision: result.page.revision, entries: result.page.recentSearches, pending: [] };
      for (const pending of provisional) restored = localChange(restored, pending.change, true);
      save(restored);
    }
    if (!result.page) return fail();
    if (!snapshot.data.pending.length) {
      accept(result.page);
      succeeded = true;
      return;
    }
    // Preserve the revision actually observed by this account's offline queue, including removes and clears.
    for (let n = 0; n < 100 && snapshot.data.pending.length; n++) {
      const pending = snapshot.data.pending[0]!,
        state = snapshot.data;
      inFlight = pending.key;
      const response = await writeRecent({
        data: { accountId: result.accountId, expectedRevision: state.revision, pending },
        headers: { 'X-CSRF-Token': sessionCsrfToken() ?? '' },
      });
      if (!live()) return;
      inFlight = undefined;
      if (!response.ok) return fail(response.code === 'conflict' ? 'conflict' : 'unavailable');
      const entry = pending.change.kind === 'use' ? pending.change.entry : null;
      const receipt = response.value;
      save({
        ...snapshot.data,
        revision: receipt.revision,
        entries: snapshot.data.entries.map((item) =>
          entry && receipt.id && entryKey(item.entry) === entryKey(entry)
            ? { ...item, id: receipt.id, revision: receipt.revision, lastUsed: receipt.lastUsed }
            : item,
        ),
        pending: snapshot.data.pending
          .filter((p) => p.key !== pending.key)
          .map((p) =>
            p.change.kind === 'remove' && receipt.id && p.change.id === `pending:${pending.key}`
              ? { ...p, change: { kind: 'remove', id: receipt.id } }
              : p,
          ),
      });
    }
    const refreshed = await readRecent({ data: undefined });
    if (!live()) return;
    if (refreshed.accountId !== result.accountId || !refreshed.page) return fail();
    if (!snapshot.data.pending.length) accept(refreshed.page);
    update({ status: 'ready' });
    succeeded = true;
  } catch {
    if (live()) fail();
  } finally {
    if (live()) {
      busy = -1;
      inFlight = undefined;
      if (requested && succeeded) void synchronize();
    }
  }
}
function setSession(value: string, accountId: string | null) {
  if (session === value && sessionOwner === accountId) return;
  sessionOwner = accountId;
  generation++;
  session = value;
  inFlight = undefined;
  update({ ...initial, status: value === 'signed-out' ? 'local' : 'loading' });
  if (value === 'signed-out') {
    try {
      const accountCache = localStorage.getItem(marker);
      for (const key of Object.keys(localStorage))
        if (key.startsWith('rezics.search-history.v1:') || (accountCache && key.startsWith(RECENT_STORAGE)))
          localStorage.removeItem(key);
      save(restoreRecent(localStorage.getItem(RECENT_STORAGE + 'anonymous')));
    } catch {
      /* Memory remains usable. */
    }
  } else void synchronize();
}
export function useRecentSearches() {
  const { state, subject } = useSession(),
    client = useContext(QueryClientContext);
  const current = useSyncExternalStore(
    subscribe,
    () => snapshot,
    () => initial,
  );
  useEffect(() => setSession(state, subject ?? null), [state, subject]);
  useEffect(() => {
    const refresh = () => void synchronize();
    const events = ['focus', 'online', 'storage'];
    events.forEach((event) => window.addEventListener(event, refresh));
    return () => events.forEach((event) => window.removeEventListener(event, refresh));
  }, []);
  const scope = useSyncExternalStore(
    (listener) => client?.getQueryCache().subscribe(listener) ?? (() => {}),
    () => {
      const path = window.location.pathname,
        match = path.match(/\/(realms|collections)\/([0-9a-f-]{36})\/?$/);
      if (match)
        return JSON.stringify({
          kind: 'scope',
          scope: { kind: match[1] === 'realms' ? 'realm' : 'collection', id: match[2] },
        });
      if (/\/library\/?$/.test(path))
        return JSON.stringify({ kind: 'scope', scope: { kind: 'route', route: 'library' } });
      const address = path.match(/\/spaces\/([^/]+)\/?$/)?.[1];
      if (address && client) {
        // Reuse the actual current page's owner data, including the protected Realm's session read.
        const key = ['space', decodeURIComponent(address), getLocale()];
        const personal = client.getQueryState<SpacePageData>([...key, 'session']);
        const page =
          personal?.status === 'success' && personal.fetchStatus === 'idle'
            ? personal.data
            : client.getQueryData<SpacePageData>([...key, 'anonymous']);
        if (page?.realm) return JSON.stringify({ kind: 'scope', scope: { kind: 'realm', id: page.realm.id } });
      }
      return '';
    },
    () => '',
  );
  useEffect(() => {
    if (state !== 'signed-out' && !current.accountId) return;
    const key = `${state}:${current.accountId}:${window.location.pathname}:${scope}`;
    if (lastVisit === key) return;
    lastVisit = key;
    if (scope) changeRecent({ kind: 'use', entry: JSON.parse(scope) as RecentEntry });
  });
  const visible = state === session && (subject ?? null) === sessionOwner ? current : initial;
  return {
    entries: visible.data.entries,
    status: visible.status,
    next: visible.next,
    onRemove: (id: string) => changeRecent({ kind: 'remove', id }),
    onClear: () => changeRecent({ kind: 'clear' }),
    remember: (entry: RecentEntry) => changeRecent({ kind: 'use', entry }),
    onReload: () => {
      if (snapshot.status === 'conflict') save({ ...snapshot.data, pending: [] });
      void synchronize();
    },
    onMore: async () => {
      const { accountId, next, data } = snapshot;
      if (!next || data.pending.length || busy === generation) return;
      const run = generation;
      try {
        const result = await readRecent({ data: next });
        if (run !== generation) return;
        if (
          result.accountId === accountId &&
          result.page &&
          result.page.revision === snapshot.data.revision &&
          !snapshot.data.pending.length
        ) {
          save({ ...snapshot.data, entries: [...snapshot.data.entries, ...result.page.recentSearches].slice(0, 100) });
          update({ next: result.page.next });
        } else fail('conflict');
      } catch {
        if (run === generation) fail();
      }
    },
  };
}
type ViewProps = {
  entries: RecentItem[];
  status: RecentState;
  onRemove(id: string): void;
  onClear?(): void;
  onReload?(): void;
  history?: boolean;
  onMore?(): void;
  next?: string | null;
};
export function RecentHistoryView(props: ViewProps) {
  const { entries, status, onRemove, onClear, onReload, history = false, onMore, next } = props;
  const locale = getLocale();
  return (
    <section className="space-y-2 px-3 py-3" aria-label={m.search_recent()}>
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">{history ? m.search_history() : m.search_recent()}</h2>
        {history ? (
          <Button type="button" variant="ghost" size="sm" onClick={onClear} disabled={!entries.length}>
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
      <ul>
        {entries.slice(0, history ? 100 : 5).map((item) => {
          const name =
            item.entry.kind === 'query'
              ? item.entry.text
              : item.entry.scope.kind === 'route'
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
                <span className="truncate text-sm">{name}</span>
              </Tag>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                aria-label={m.search_history_remove({ name })}
                onClick={() => onRemove(item.id)}
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
