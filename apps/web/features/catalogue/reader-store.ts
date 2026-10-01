import { browserMainApi } from '../api/browser.ts';
import type { MainClient } from '../discover/types.ts';
import { mainTrackingApi, type TrackingApi } from '../tracking/api.ts';
import type { ReaderActions, ReaderWorkState, ReadingStatus } from './reader-actions.tsx';

// Main's reader library (`services/main/src/routes/library.ts`): status
// shelves with a compare-and-set version, the reader's own ratings, and a
// batched read for a page of cards.

type Ok<Call> = Call extends (...args: never[]) => Promise<{ data: infer Data }> ? NonNullable<Data> : never;
export type ReaderStateItem = Ok<MainClient['v1']['me']['work-states']['get']>['items'][number];

/** One Work's reader state as Main last answered: the status with its version, and the global rating's head. */
export interface ReaderEntry {
  status: ReadingStatus | null;
  version: number;
  rating: { value: number | null; revision: string } | null;
}

/** Reader state read on the server for the Works a page renders, by Work IRI; it crosses to the browser as JSON. */
export type ReaderSeed = Record<string, ReaderEntry>;

/** What the Work page's stars rate: everyone's standing question for the Work's Main Version, on its scale. */
export interface RatingTarget { work: string; context: string; mainVersion: string; max: number }

// Main's batch limit (`READER_LIBRARY_COST.batchWorks`).
export const READER_BATCH = 24;

export function readerEntry(item: Pick<ReaderStateItem, 'status' | 'rating'>): ReaderEntry {
  const own = item.rating.global;
  return { status: item.status.status, version: item.status.version,
    rating: own ? { value: own.availability === 'available' ? own.value : null, revision: own.revision } : null };
}

/**
 * Reads the reader's state for Works, in batches Main accepts; Works Main could
 * not answer are left out, to be read again when drawn. Null when Main denies
 * this Agent a reader library, so no control is drawn that could not act.
 */
export async function readReaderSeed(main: MainClient, actingSubject: string, works: readonly string[]):
  Promise<ReaderSeed | null> {
  const unique = [...new Set(works)];
  const seed: ReaderSeed = {};
  let denied = false;
  await Promise.all(Array.from({ length: Math.ceil(unique.length / READER_BATCH) }, async (_, index) => {
    const batch = unique.slice(index * READER_BATCH, (index + 1) * READER_BATCH);
    try {
      const { data, error } = await main.v1.me['work-states'].get({ query: { works: batch.join(','), actingSubject } });
      if (error?.status === 403) denied = true;
      for (const item of data?.items ?? []) seed[item.work] = readerEntry(item);
    } catch { /* The controls read these Works again in the browser when they are drawn. */ }
  }));
  return denied ? null : seed;
}

/**
 * Main projects an attempt onto the Work's shelf (finished reads as Read, planned as Want to read, did
 * not finish takes it off). After a write that took, the shelf state is read again, so the status
 * button and anything keyed on it follow without a reload.
 */
export function shelfFollowing(tracking: TrackingApi, changed: (work: string) => void): TrackingApi {
  const after = <T extends { ok: boolean }>(written: T & { data?: { target: { work: string | null } } }): T => {
    const work = written.ok ? written.data?.target.work : null;
    if (work) changed(work);
    return written;
  };
  return { ...tracking,
    start: async (work, input) => after(await tracking.start(work, input)),
    change: async (session, version, changes) => after(await tracking.change(session, version, changes)) };
}

/**
 * Reader actions over Main, for a signed-in reader acting as `actingSubject`.
 * State starts from the server's seed; Works drawn later ("Show more") are
 * read in batches as they appear. Writes compare and set: when another tab or
 * device changed a status first, the store reads it again and applies the
 * reader's choice once more on the new version, as reading progress does.
 */
export function createReaderStore({ actingSubject, seed = {}, ratingTarget, main = browserMainApi }: {
  actingSubject: string; seed?: ReaderSeed; ratingTarget?: RatingTarget | null; main?: () => MainClient;
}): Extract<ReaderActions, { kind: 'ready' }> {
  const entries = new Map(Object.entries(seed));
  const listeners = new Set<() => void>();
  let version = 0;
  const notify = () => { version += 1; for (const listener of listeners) listener(); };
  // Works already asked for, answered or not: a Work Main did not answer is not asked for again on every render.
  const requested = new Set<string>();
  let queued = new Set<string>();

  // Main denied this Agent a reader library: controls withdraw rather than fail on every press.
  let denied = false;
  async function readAll(works: string[]) {
    const read = await readReaderSeed(main(), actingSubject, works);
    if (read === null) denied = true;
    for (const [work, entry] of Object.entries(read ?? {})) entries.set(work, entry);
    notify();
  }
  function load(work: string) {
    // The server render shows the seed; reads for other Works start in the browser.
    if (typeof window === 'undefined' || entries.has(work) || requested.has(work)) return;
    requested.add(work);
    queued.add(work);
    if (queued.size > 1) return;
    // One batch for every card drawn in the same render.
    queueMicrotask(() => {
      const works = [...queued].filter(item => !entries.has(item));
      queued = new Set();
      if (works.length) void readAll(works);
    });
  }
  async function refresh(work: string): Promise<ReaderEntry | null> {
    const { data, error } = await main().v1.works({ id: work.slice(-36) })['reader-state'].get({ query: { actingSubject } });
    if (error?.status === 403) { denied = true; notify(); }
    if (!data) return null;
    const entry = readerEntry(data);
    entries.set(work, entry);
    notify();
    return entry;
  }

  return {
    kind: 'ready',
    ratingMax: ratingTarget?.max ?? 5,
    stateOf(work: string): ReaderWorkState {
      const entry = entries.get(work);
      if (!entry) load(work);
      return { status: entry?.status ?? null, rating: entry?.rating?.value ?? null };
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    snapshot: () => version,
    available: () => !denied,
    tracking: shelfFollowing(mainTrackingApi(actingSubject, main), work => void refresh(work)),
    async setStatus(work: string, status: ReadingStatus | null) {
      const api = main().v1.works({ id: work.slice(-36) })['reader-status'];
      const put = (entry: ReaderEntry) => api.put({ actingSubject, expectedVersion: entry.version, status },
        { headers: { 'idempotency-key': crypto.randomUUID() } });
      const base = entries.get(work) ?? await refresh(work);
      if (!base) return false;
      let response = await put(base);
      if (response.error?.status === 409) {
        const fresh = await refresh(work);
        if (fresh) response = await put(fresh);
      }
      if (!response.data) return false;
      entries.set(work, { ...(entries.get(work) ?? base), status: response.data.status, version: response.data.version });
      notify();
      return true;
    },
    rate: ratingTarget ? async (work: string, value: number | null) => {
      if (work !== ratingTarget.work) return false;
      const post = (entry: ReaderEntry | null) => main().v1['global-rating-observations'].post({
        profile: 'global-rating-standing-observation-v1', context: ratingTarget.context, work,
        mainVersion: ratingTarget.mainVersion, expectedRevisionHead: entry?.rating?.revision ?? null, value,
        actingSubject }, { headers: { 'idempotency-key': crypto.randomUUID() } });
      const base = entries.get(work) ?? await refresh(work);
      let response = await post(base);
      if (response.error?.status === 409) response = await post(await refresh(work));
      if (response.error || !response.data) return false;
      // A write Access has admitted but not yet applied answers 202 without a revision; read it back later.
      const revision = 'observationRevision' in response.data ? response.data.observationRevision : null;
      const current = entries.get(work) ?? base;
      if (current) {
        entries.set(work, { ...current, rating: revision ? { value, revision } : current.rating });
        notify();
      }
      return true;
    } : null,
  };
}
