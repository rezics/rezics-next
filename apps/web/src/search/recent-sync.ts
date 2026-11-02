import {
  NATIVE_RECENT_QUERY_TEXT_LIMIT,
  RECENT_HISTORY_LIMIT,
  readRecentDocument,
  writeRecentDocument,
  recentId,
  type RecentDocument,
  type RecentEntry,
  type RecentStorage,
  type RecentSyncAdapter,
} from './recent-history';
import { createRecentPageProgress, RECENT_HISTORY_READ_PAGE_LIMIT } from './recent-page-progress';
import { admitRecentPage, recentItemAction } from './recent-response';
import type { RecentEntry as NativeEntry, RecentItem, RecentPage, Pending } from './recent';
import { admitRecentJournal, freshRecentJournal, type RecentJournal } from './recent-journal';

export class RecentSyncError extends Error {
  constructor(readonly code: 'unavailable' | 'conflict') {
    super(code);
    this.name = 'RecentSyncError';
  }
}
export type RecentSearchTransport = {
  read(
    cursor: string | undefined,
    signal: AbortSignal,
  ): Promise<{ accountId: string | null; page: RecentPage | null; code?: string }>;
  write(
    input: { accountId: string; expectedRevision: number; pending: Pending },
    signal: AbortSignal,
  ): Promise<
    { ok: false; code: string } | { ok: true; value: { id: string | null; revision: number; lastUsed: string } }
  >;
};
export type RecentSearchSyncAdapter = RecentSyncAdapter & {
  retry(entries: readonly RecentEntry[], signal: AbortSignal): Promise<void>;
  refresh(entries: readonly RecentEntry[], signal: AbortSignal): Promise<void>;
  dispose(): void;
};
export type RecentSearchSyncOptions = {
  accountId: string;
  bucket: string;
  currentBucket(): string | null;
  storage: RecentStorage;
  onRemote?(entries: readonly RecentEntry[]): void;
  transport?: RecentSearchTransport;
};
const lifetime = 90 * 86400000;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Browser labels, links and avatars are never part of a native command. */
export function nativeRecentEntry(entry: RecentEntry): NativeEntry | undefined {
  const ref = entry.scope;
  const scope =
    ref?.kind === 'Library'
      ? { kind: 'route' as const, route: 'library' as const }
      : ref && uuid.test(ref.id) && (ref.kind === 'Collection' || ref.kind === 'Realm')
        ? { kind: ref.kind === 'Collection' ? ('collection' as const) : ('realm' as const), id: ref.id }
        : undefined;
  if (ref && !scope) return;
  if (entry.query.trim()) {
    if (entry.query.length > NATIVE_RECENT_QUERY_TEXT_LIMIT) return;
    return {
      kind: 'query',
      text: entry.query,
      ...(entry.languages !== undefined ? { languages: [...entry.languages] } : {}),
      ...(scope ? { scope } : {}),
    };
  }
  if (scope) return { kind: 'scope', scope };
}
export function localRecentEntry(item: RecentItem): RecentEntry {
  const ref = item.entry.scope;
  const action = recentItemAction(item);
  const scope = ref
    ? {
        kind:
          ref.kind === 'route'
            ? ('Library' as const)
            : ref.kind === 'realm'
              ? ('Realm' as const)
              : ('Collection' as const),
        id: ref.kind === 'route' ? ref.route : ref.id,
        name: item.display?.name ?? '',
        ...(action ? { searchAction: action } : {}),
      }
    : undefined;
  const query = item.entry.kind === 'query' ? item.entry.text : '';
  const languages = item.entry.kind === 'query' ? item.entry.languages : undefined;
  return {
    id: recentId(query, scope, languages),
    query,
    ...(languages !== undefined ? { languages: [...languages] } : {}),
    ...(scope ? { scope } : {}),
    visitedAt: Date.parse(item.lastUsed),
  };
}
function journalOf(document: RecentDocument): RecentJournal {
  if (document.native === undefined) return freshRecentJournal();
  const journal = admitRecentJournal(document.native);
  if (!journal) throw new RecentSyncError('unavailable');
  return journal;
}
const transport: RecentSearchTransport = {
  async read(cursor, signal) {
    const { readRecent } = await import('./recent');
    signal.throwIfAborted();
    return readRecent({ data: cursor, signal });
  },
  async write(input, signal) {
    const [{ writeRecent }, { sessionCsrfToken }] = await Promise.all([import('./recent'), import('../session/query')]);
    signal.throwIfAborted();
    return writeRecent({ data: input, signal, headers: { 'X-CSRF-Token': sessionCsrfToken() ?? '' } });
  },
};
// Only mutual exclusion lives here, never history or native data. The journal is in the sole local history key.
const turns = new Map<string, Promise<unknown>>();
async function serial<T>(bucket: string, work: () => Promise<T>): Promise<T> {
  const previous = turns.get(bucket) ?? Promise.resolve();
  const turn = previous
    .catch(() => {})
    .then(async () => {
      if (typeof navigator !== 'undefined' && navigator.locks)
        return navigator.locks.request(`search-history:${bucket}`, work);
      return work();
    });
  turns.set(bucket, turn);
  try {
    return await turn;
  } finally {
    if (turns.get(bucket) === turn) turns.delete(bucket);
  }
}

/** Reconciles visits/removals once, retaining the exact receipt and observed revision across retries. */
export function createRecentSearchSyncAdapter(options: RecentSearchSyncOptions): RecentSearchSyncAdapter {
  const { accountId, bucket, storage, currentBucket, onRemote } = options;
  const api = options.transport ?? transport;
  const lifetimeAbort = new AbortController();
  let needsRead = true;
  const live = (signal: AbortSignal) => {
    signal.throwIfAborted();
    if (bucket !== `account:${accountId}` || currentBucket() !== bucket)
      throw new DOMException('Recent account changed', 'AbortError');
  };
  const load = () => readRecentDocument(storage, bucket);
  const nativeKey = (entry: NativeEntry | undefined) => {
    if (!entry) return;
    const scope = entry.scope;
    return JSON.stringify([
      entry.kind,
      entry.kind === 'query' ? entry.text.trim() : '',
      scope?.kind ?? null,
      scope ? (scope.kind === 'route' ? scope.route : scope.id.toLowerCase()) : null,
      entry.kind === 'query' ? (entry.languages ?? null) : null,
    ]);
  };
  const save = (document: RecentDocument, journal: RecentJournal) =>
    writeRecentDocument(storage, bucket, { ...document, native: journal });
  function reconcile(snapshot?: readonly RecentEntry[]): { document: RecentDocument; journal: RecentJournal } {
    const document = load(),
      journal = journalOf(document);
    if (
      snapshot &&
      document.entries.length === snapshot.length &&
      document.entries.every(
        (entry, index) => entry.id === snapshot[index]?.id && entry.visitedAt === snapshot[index]?.visitedAt,
      )
    )
      document.entries = [...snapshot];
    journal.pending = journal.pending.filter((p) => Date.parse(p.queuedAt) > Date.now() - lifetime);
    const push = (change: Pending['change'], extra: Partial<RecentJournal['pending'][number]> = {}) => {
      if (journal.pending.length >= 100) throw new RecentSyncError('unavailable');
      journal.pending.push({ key: crypto.randomUUID(), change, queuedAt: new Date().toISOString(), ...extra });
    };
    // Do not rebase an unacknowledged command, even when its response was lost.
    if (document.clear) {
      journal.pending = journal.pending.filter((p) => p.expectedRevision !== undefined);
      push({ kind: 'clear' });
      delete document.clear;
    }
    for (const id of document.removed) {
      journal.pending = journal.pending.filter(
        (p) => p.localId !== id || p.expectedRevision !== undefined || p.change.kind !== 'use',
      );
      const use = journal.pending.find((p) => p.localId === id && p.change.kind === 'use');
      const row = journal.rows[id];
      if (row || use) push({ kind: 'remove', id: row?.id ?? `pending:${use!.key}` }, { localId: id });
      delete journal.observed[id];
    }
    document.removed = [];
    document.entries = document.entries.filter((e) => e.visitedAt > Date.now() - lifetime);
    for (const entry of document.entries) {
      if (journal.observed[entry.id] === entry.visitedAt) continue;
      let native = nativeRecentEntry(entry);
      if (native) {
        // A visit not yet attempted can be coalesced; attempted receipt bodies are immutable.
        journal.pending = journal.pending.filter(
          (p) => p.localId !== entry.id || p.change.kind !== 'use' || p.expectedRevision !== undefined,
        );
        push({ kind: 'use', entry: native }, { localId: entry.id, visitedAt: entry.visitedAt });
      }
    }
    journal.observed = Object.fromEntries(document.entries.map((e) => [e.id, e.visitedAt]));
    save(document, journal);
    return { document, journal };
  }
  async function read(signal: AbortSignal) {
    const progress = createRecentPageProgress<RecentItem>();
    let cursor: string | undefined, revision: number | undefined;
    for (let request = 0; request < RECENT_HISTORY_READ_PAGE_LIMIT; request++) {
      live(signal);
      const response = await api.read(cursor, signal);
      live(signal);
      if (response.accountId !== accountId || !response.page)
        throw new RecentSyncError(response.code === 'stale_cursor' ? 'conflict' : 'unavailable');
      const page = admitRecentPage(response.page);
      if (!page) throw new RecentSyncError('unavailable');
      if (revision !== undefined && revision !== page.revision) throw new RecentSyncError('conflict');
      revision = page.revision;
      if (!progress.accept(page)) throw new RecentSyncError('unavailable');
      cursor = page.next ?? undefined;
      if (!cursor || progress.rows.length >= RECENT_HISTORY_LIMIT)
        return { rows: progress.rows.slice(0, RECENT_HISTORY_LIMIT), revision: revision! };
    }
    throw new RecentSyncError('unavailable');
  }
  function merge(rows: RecentItem[], revision: number, signal: AbortSignal) {
    live(signal);
    const { document, journal } = reconcile();
    if (journal.pending.length) return false;
    const locals = document.entries;
    const seen = new Set<string>();
    const remote = rows.flatMap((item) => {
      const converted = localRecentEntry(item);
      // Keep a locally supplied scope identity, but only the current owner's display.
      const local = locals.find((e) => nativeKey(nativeRecentEntry(e)) === nativeKey(item.entry));
      if (local) {
        converted.query = local.query;
        if (converted.scope && local.scope) converted.scope.id = local.scope.id;
        converted.id = recentId(converted.query, converted.scope, converted.languages);
      }
      if (seen.has(converted.id)) return [];
      seen.add(converted.id);
      journal.rows[converted.id] = { id: item.id, visitedAt: converted.visitedAt, entry: item.entry };
      return [converted];
    });
    const entries = [...locals.filter((e) => !nativeRecentEntry(e)), ...remote]
      .sort((a, b) => b.visitedAt - a.visitedAt)
      .slice(0, RECENT_HISTORY_LIMIT);
    journal.revision = revision;
    journal.observed = Object.fromEntries(entries.map((e) => [e.id, e.visitedAt]));
    journal.rows = Object.fromEntries(Object.entries(journal.rows).filter(([id]) => entries.some((e) => e.id === id)));
    save({ ...document, entries }, journal);
    live(signal);
    onRemote?.(entries);
    return true;
  }
  async function run(input: readonly RecentEntry[], external: AbortSignal, retry = false) {
    const signal = AbortSignal.any([external, lifetimeAbort.signal]);
    live(signal);
    return serial(bucket, async () => {
      live(signal);
      // The caller's entries may already be stale. Always use the sole persisted local document.
      let { document, journal } = reconcile(input);
      if (journal.conflict) {
        if (!retry) throw new RecentSyncError('conflict');
        journal = freshRecentJournal();
        document = { entries: document.entries.filter((e) => !nativeRecentEntry(e)), removed: [] };
        save(document, journal);
        onRemote?.(document.entries);
        needsRead = true;
      }
      try {
        if (needsRead || journal.revision === null) {
          const page = await read(signal);
          ({ document, journal } = reconcile());
          if (journal.revision === null) {
            journal.revision = page.revision;
            save(document, journal);
          }
          if (!journal.pending.length) merge(page.rows, page.revision, signal);
          needsRead = false;
        }
        for (let n = 0; n < 100; n++) {
          live(signal);
          ({ document, journal } = reconcile());
          const pending = journal.pending[0];
          if (!pending) break;
          if (pending.expectedRevision === undefined) pending.expectedRevision = journal.revision!;
          save(document, journal);
          const response = await api.write({ accountId, expectedRevision: pending.expectedRevision, pending }, signal);
          live(signal);
          ({ document, journal } = reconcile());
          if (!response.ok)
            throw new RecentSyncError(
              response.code === 'conflict' || response.code === 'idempotency_conflict' ? 'conflict' : 'unavailable',
            );
          const receipt = response.value;
          if (
            receipt.revision !== pending.expectedRevision + 1 ||
            !Number.isFinite(Date.parse(receipt.lastUsed)) ||
            (pending.change.kind === 'use' && (!receipt.id || !uuid.test(receipt.id)))
          )
            throw new RecentSyncError('unavailable');
          journal.revision = receipt.revision;
          journal.pending = journal.pending
            .filter((p) => p.key !== pending.key)
            .map((p) =>
              p.change.kind === 'remove' && p.change.id === `pending:${pending.key}` && receipt.id
                ? { ...p, change: { kind: 'remove', id: receipt.id } }
                : p,
            );
          if (pending.localId && receipt.id)
            journal.rows[pending.localId] = {
              id: receipt.id,
              visitedAt: pending.visitedAt!,
              ...(pending.change.kind === 'use' ? { entry: pending.change.entry } : {}),
            };
          if (pending.change.kind === 'remove' && pending.localId) delete journal.rows[pending.localId];
          if (pending.change.kind === 'clear') journal.rows = {};
          save(document, journal);
          needsRead = true;
        }
        if (journal.pending.length) throw new RecentSyncError('unavailable');
        if (needsRead) {
          const page = await read(signal);
          if (!merge(page.rows, page.revision, signal)) throw new RecentSyncError('unavailable');
          needsRead = false;
        }
      } catch (error) {
        live(signal);
        needsRead = true;
        const document = load(),
          journal = journalOf(document);
        if (error instanceof RecentSyncError && error.code === 'conflict') journal.conflict = true;
        save(document, journal);
        onRemote?.(
          document.entries.map((e) =>
            e.scope && nativeRecentEntry(e) ? { ...e, scope: { kind: e.scope.kind, id: e.scope.id, name: '' } } : e,
          ),
        );
        throw error instanceof RecentSyncError ? error : new RecentSyncError('unavailable');
      }
    });
  }
  return {
    sync: (entries, signal) => run(entries, signal),
    refresh: (entries, signal) => {
      needsRead = true;
      return run(entries, signal);
    },
    retry: (entries, signal) => run(entries, signal, true),
    dispose: () => lifetimeAbort.abort(),
  };
}
