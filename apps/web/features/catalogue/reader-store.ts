import { browserMainApi } from '../api/browser.ts';
import { relationshipsChanged } from '../relationships/events.ts';
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
    if (work) { changed(work); relationshipsChanged(); }
    return written;
  };
  return { ...tracking,
    start: async (work, input) => after(await tracking.start(work, input)),
    change: async (session, version, changes) => after(await tracking.change(session, version, changes)) };
}

/**
 * One write at a time for one Work and field. A choice made while a write is in flight replaces any choice waiting
 * behind it (the newest wins), and every caller waiting on a replaced choice gets the outcome of the one that stood.
 * `apply` writes one choice and is told, through `superseded`, when a newer one is waiting so it can stop retrying.
 */
function lane<T>(apply: (choice: T, superseded: () => boolean) => Promise<boolean>) {
  let running = false;
  let latest: { choice: T } | null = null;
  let waiting: ((saved: boolean) => void)[] = [];
  async function run() {
    running = true;
    while (latest) {
      const { choice } = latest;
      const batch = waiting;
      latest = null;
      waiting = [];
      const saved = await apply(choice, () => latest !== null).catch(() => false);
      // A newer choice arrived meanwhile: these callers wait for it instead.
      if (latest) waiting = [...batch, ...waiting];
      else for (const resolve of batch) resolve(saved);
    }
    running = false;
  }
  return (choice: T) => new Promise<boolean>(resolve => {
    latest = { choice };
    waiting.push(resolve);
    if (!running) void run();
  });
}

/** A rating write Access admitted but Main has not applied: the choice shown until its revision is read back. */
interface Unapplied { value: number | null; baseRevision: string | null; state: 'pending' | 'unsettled' }

/** Reads back an admitted rating this many times, waiting longer each time, before saying it is still processing. */
export const READ_BACK_DELAYS_MS = [400, 800, 1600, 3200] as const;

/**
 * Reader actions over Main, for a signed-in reader acting as `actingSubject`.
 * State starts from the server's seed; Works drawn later ("Show more") are
 * read in batches as they appear. Writes compare and set, one at a time per
 * Work and field: a choice made while one is being written replaces any
 * waiting behind it, and when another tab or device changed the value first
 * (409) the store reads it again and applies only the newest choice, only if it
 * still differs from what Main now holds. A rating Access has admitted but not
 * applied is shown as pending and read back a bounded number of times.
 */
export function createReaderStore({ actingSubject, seed = {}, ratingTarget, main = browserMainApi,
  wait = milliseconds => new Promise<void>(resolve => setTimeout(resolve, milliseconds)) }: {
  actingSubject: string; seed?: ReaderSeed; ratingTarget?: RatingTarget | null; main?: () => MainClient;
  /** Waits between read-backs of a pending rating; tests pass one that returns at once. */
  wait?: (milliseconds: number) => Promise<void>;
}): Extract<ReaderActions, { kind: 'ready' }> {
  const entries = new Map(Object.entries(seed));
  const unapplied = new Map<string, Unapplied>();
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

  async function writeStatus(work: string, status: ReadingStatus | null, superseded: () => boolean) {
    const api = main().v1.works({ id: work.slice(-36) })['reader-status'];
    const put = (entry: ReaderEntry) => api.put({ actingSubject, expectedVersion: entry.version, status },
      { headers: { 'idempotency-key': crypto.randomUUID() } });
    const base = entries.get(work) ?? await refresh(work);
    if (!base) return false;
    let response = await put(base);
    if (response.error?.status === 409) {
      const fresh = await refresh(work);
      if (!fresh) return false;
      // A newer choice is waiting, or Main already holds this one: there is nothing of this choice left to write.
      if (superseded() || fresh.status === status) return !superseded();
      response = await put(fresh);
    }
    if (!response.data) return false;
    entries.set(work, { ...(entries.get(work) ?? base), status: response.data.status, version: response.data.version });
    notify();
    relationshipsChanged();
    return true;
  }

  /** Reads the Work's state again until the rating's head moves past `baseRevision`; false if it never does. */
  async function readBack(work: string, baseRevision: string | null, superseded: () => boolean) {
    for (const delay of READ_BACK_DELAYS_MS) {
      await wait(delay);
      const entry = await refresh(work);
      if (entry && (entry.rating?.revision ?? null) !== baseRevision) return true;
      if (superseded()) return false;
    }
    return false;
  }

  async function writeRating(target: RatingTarget, value: number | null, superseded: () => boolean) {
    const { work } = target;
    const post = (entry: ReaderEntry) => main().v1['global-rating-observations'].post({
      profile: 'global-rating-standing-observation-v1', context: target.context, work,
      mainVersion: target.mainVersion, expectedRevisionHead: entry.rating?.revision ?? null, value,
      actingSubject }, { headers: { 'idempotency-key': crypto.randomUUID() } });
    const base = entries.get(work) ?? await refresh(work);
    if (!base) return false;
    let from = base;
    let response = await post(from);
    if (response.error?.status === 409) {
      const fresh = await refresh(work);
      if (!fresh) return false;
      if (superseded() || (fresh.rating?.value ?? null) === value) return !superseded();
      from = fresh;
      response = await post(from);
    }
    if (response.error || !response.data) return false;
    const revision = 'observationRevision' in response.data ? response.data.observationRevision : null;
    if (revision) {
      entries.set(work, { ...(entries.get(work) ?? from), rating: { value, revision } });
      notify();
      return true;
    }
    // Admitted but not applied (202): pending until the head moves, never settled by assumption.
    const baseRevision = from.rating?.revision ?? null;
    unapplied.set(work, { value, baseRevision, state: 'pending' });
    notify();
    const applied = await readBack(work, baseRevision, superseded);
    if (applied || superseded()) unapplied.delete(work);
    else unapplied.set(work, { value, baseRevision, state: 'unsettled' });
    notify();
    return true;
  }

  const statusLanes = new Map<string, (status: ReadingStatus | null) => Promise<boolean>>();
  const ratingLanes = new Map<string, (value: number | null) => Promise<boolean>>();
  const laneOf = <T>(lanes: Map<string, (choice: T) => Promise<boolean>>, work: string,
    apply: (choice: T, superseded: () => boolean) => Promise<boolean>) => {
    let existing = lanes.get(work);
    if (!existing) lanes.set(work, existing = lane(apply));
    return existing;
  };

  return {
    kind: 'ready',
    ratingMax: ratingTarget?.max ?? 5,
    stateOf(work: string): ReaderWorkState {
      const entry = entries.get(work);
      if (!entry) load(work);
      const waiting = unapplied.get(work);
      return { status: entry?.status ?? null, rating: waiting ? waiting.value : entry?.rating?.value ?? null,
        ...waiting ? { ratingWrite: waiting.state } : {} };
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    snapshot: () => version,
    available: () => !denied,
    tracking: shelfFollowing(mainTrackingApi(actingSubject, main), work => void refresh(work)),
    setStatus: (work: string, status: ReadingStatus | null) =>
      laneOf(statusLanes, work, (choice, superseded) => writeStatus(work, choice, superseded))(status),
    rate: ratingTarget ? (work: string, value: number | null) => work !== ratingTarget.work ? Promise.resolve(false)
      : laneOf(ratingLanes, work, (choice, superseded) => writeRating(ratingTarget, choice, superseded))(value) : null,
    async refresh(work: string) {
      const entry = await refresh(work);
      const waiting = unapplied.get(work);
      if (waiting && entry && (entry.rating?.revision ?? null) !== waiting.baseRevision) unapplied.delete(work);
      notify();
    },
  };
}
