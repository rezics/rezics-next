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

/** What a lane's write is told about the round it runs in. */
interface Round {
  /** True when a newer choice is waiting behind this one, so it should stop retrying. */
  superseded: () => boolean;
  /** True when the previous round was superseded after reading what Main holds, so that reading is still fresh. */
  afterSuperseded: boolean;
}

/**
 * One write at a time for one Work and field. A choice made while a write is in flight replaces any choice waiting
 * behind it (the newest wins), and every caller waiting on a replaced choice gets the outcome of the one that stood.
 * `apply` writes one choice; `cancel` drops what is waiting and stops the lane after the write in flight.
 */
function lane<T>(apply: (choice: T, round: Round) => Promise<boolean>) {
  let running = false;
  let cancelled = false;
  let latest: { choice: T } | null = null;
  let waiting: ((saved: boolean) => void)[] = [];
  async function run() {
    running = true;
    let afterSuperseded = false;
    while (latest && !cancelled) {
      const { choice } = latest;
      const batch = waiting;
      latest = null;
      waiting = [];
      const saved = await apply(choice, { superseded: () => latest !== null || cancelled, afterSuperseded })
        .catch(() => false);
      afterSuperseded = latest !== null;
      // A newer choice arrived meanwhile: these callers wait for it instead.
      if (latest && !cancelled) waiting = [...batch, ...waiting];
      else for (const resolve of batch) resolve(saved && !cancelled);
    }
    running = false;
  }
  return {
    submit: (choice: T) => new Promise<boolean>(resolve => {
      if (cancelled) { resolve(false); return; }
      latest = { choice };
      waiting.push(resolve);
      if (!running) void run();
    }),
    cancel() {
      cancelled = true;
      latest = null;
      for (const resolve of waiting) resolve(false);
      waiting = [];
    },
  };
}

/** A rating write Access admitted but Main has not applied: the choice shown until it appears in Main's state. */
interface Unapplied { value: number | null; baseRevision: string | null; state: 'pending' | 'unsettled' }

/** Reads back an admitted rating this many times, waiting longer each time, before saying it is still processing. */
export const READ_BACK_DELAYS_MS = [400, 800, 1600, 3200] as const;

type Field = 'status' | 'rating';

/**
 * Reader actions over Main, for a signed-in reader acting as `actingSubject`.
 * State starts from the server's seed; Works drawn later ("Show more") are
 * read in batches as they appear. Writes compare and set, one at a time per
 * Work and field: a choice made while one is being written replaces any
 * waiting behind it, and when another tab or device changed the value first
 * (409) the store reads it again and applies only the newest choice, only if it
 * still differs from what Main now holds. A rating Access has admitted but not
 * applied is shown as pending and read back a bounded number of times; it is
 * settled only when Main's state shows its value after the head moved. A read
 * never replaces a field a write of this store has settled since the read began.
 * `connect()` returns the disposal that cancels queued choices and read-back timers.
 */
export function createReaderStore({ actingSubject, seed = {}, ratingTarget, main = browserMainApi,
  wait = (milliseconds, signal) => new Promise<void>(resolve => {
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  }) }: {
  actingSubject: string; seed?: ReaderSeed; ratingTarget?: RatingTarget | null; main?: () => MainClient;
  /** Waits between read-backs of a pending rating; tests pass one that returns at once. */
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}): Extract<ReaderActions, { kind: 'ready' }> {
  const entries = new Map(Object.entries(seed));
  const unapplied = new Map<string, Unapplied>();
  const listeners = new Set<() => void>();
  let version = 0;
  const notify = () => { version += 1; for (const listener of listeners) listener(); };
  // Works already asked for, answered or not: a Work Main did not answer is not asked for again on every render.
  const requested = new Set<string>();
  let queued = new Set<string>();
  let closing = new AbortController();
  const alive = () => !closing.signal.aborted;
  // Bumped whenever a write of this store settles a field, so an older read cannot put an older value back.
  const settled: Record<Field, Map<string, number>> = { status: new Map(), rating: new Map() };
  const settledAt = (field: Field, work: string) => settled[field].get(work) ?? 0;
  const settle = (field: Field, work: string) => settled[field].set(work, settledAt(field, work) + 1);

  // Main denied this Agent a reader library: controls withdraw rather than fail on every press.
  let denied = false;
  async function readAll(works: string[]) {
    const read = await readReaderSeed(main(), actingSubject, works);
    if (read === null) denied = true;
    for (const [work, entry] of Object.entries(read ?? {})) if (!entries.has(work)) entries.set(work, entry);
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
  /**
   * Reads the Work's state and returns what Main answered. The store keeps it field by field: a field a write has
   * settled since this read began, or whose status version is older than the one held, is left as it is.
   */
  async function refresh(work: string): Promise<ReaderEntry | null> {
    const seenStatus = settledAt('status', work);
    const seenRating = settledAt('rating', work);
    const { data, error } = await main().v1.works({ id: work.slice(-36) })['reader-state'].get({ query: { actingSubject } });
    if (error?.status === 403) { denied = true; notify(); }
    if (!data) return null;
    const server = readerEntry(data);
    const held = entries.get(work);
    if (!held) entries.set(work, server);
    else {
      const status = settledAt('status', work) === seenStatus || server.version > held.version;
      entries.set(work, { status: status ? server.status : held.status, version: status ? server.version : held.version,
        rating: settledAt('rating', work) === seenRating ? server.rating : held.rating });
    }
    notify();
    return server;
  }

  async function writeStatus(work: string, status: ReadingStatus | null, { superseded, afterSuperseded }: Round) {
    const api = main().v1.works({ id: work.slice(-36) })['reader-status'];
    const put = (entry: ReaderEntry) => api.put({ actingSubject, expectedVersion: entry.version, status },
      { headers: { 'idempotency-key': crypto.randomUUID() } });
    const base = entries.get(work) ?? await refresh(work);
    if (!base || !alive()) return false;
    // The last round read what Main holds and was superseded by this choice: no write if Main already has it.
    if (afterSuperseded && base.status === status) return true;
    let response = await put(base);
    if (!alive()) return false;
    if (response.error?.status === 409) {
      const fresh = await refresh(work);
      if (!fresh || !alive()) return false;
      // A newer choice is waiting, or Main already holds this one: there is nothing of this choice left to write.
      if (superseded() || fresh.status === status) return !superseded();
      response = await put(fresh);
      if (!alive()) return false;
    }
    if (!response.data) return false;
    entries.set(work, { ...(entries.get(work) ?? base), status: response.data.status, version: response.data.version });
    settle('status', work);
    notify();
    relationshipsChanged();
    return true;
  }

  /** Reads the Work's state again until its rating shows `value` on a head past `baseRevision`; false if it never does. */
  async function readBack(work: string, baseRevision: string | null, value: number | null, superseded: () => boolean) {
    for (const delay of READ_BACK_DELAYS_MS) {
      await wait(delay, closing.signal);
      if (!alive()) return false;
      // A read that fails is no answer yet: the next one may.
      const server = await refresh(work).catch(() => null);
      if (!alive()) return false;
      if (server && (server.rating?.revision ?? null) !== baseRevision && (server.rating?.value ?? null) === value)
        return true;
      if (superseded()) return false;
    }
    return false;
  }

  async function writeRating(target: RatingTarget, value: number | null, { superseded, afterSuperseded }: Round) {
    const { work } = target;
    const post = (entry: ReaderEntry) => main().v1['global-rating-observations'].post({
      profile: 'global-rating-standing-observation-v1', context: target.context, work,
      mainVersion: target.mainVersion, expectedRevisionHead: entry.rating?.revision ?? null, value,
      actingSubject }, { headers: { 'idempotency-key': crypto.randomUUID() } });
    const base = entries.get(work) ?? await refresh(work);
    if (!base || !alive()) return false;
    if (afterSuperseded && (base.rating?.value ?? null) === value && !unapplied.has(work)) return true;
    let from = base;
    let response = await post(from);
    if (!alive()) return false;
    if (response.error?.status === 409) {
      const fresh = await refresh(work);
      if (!fresh || !alive()) return false;
      if (superseded() || (fresh.rating?.value ?? null) === value) return !superseded();
      from = fresh;
      response = await post(from);
      if (!alive()) return false;
    }
    if (response.error || !response.data) return false;
    const revision = 'observationRevision' in response.data ? response.data.observationRevision : null;
    if (revision) {
      entries.set(work, { ...(entries.get(work) ?? from), rating: { value, revision } });
      settle('rating', work);
      // A newer write that took replaces whatever an older one left unapplied.
      unapplied.delete(work);
      notify();
      return true;
    }
    // Admitted but not applied (202): pending until Main's state shows it, never settled by assumption.
    const baseRevision = from.rating?.revision ?? null;
    unapplied.set(work, { value, baseRevision, state: 'pending' });
    notify();
    let applied = false;
    try { applied = await readBack(work, baseRevision, value, superseded); } finally {
      if (!alive()) unapplied.delete(work);
      else if (applied || superseded()) unapplied.delete(work);
      else unapplied.set(work, { value, baseRevision, state: 'unsettled' });
      notify();
    }
    return true;
  }

  const statusLanes = new Map<string, ReturnType<typeof lane<ReadingStatus | null>>>();
  const ratingLanes = new Map<string, ReturnType<typeof lane<number | null>>>();
  const laneOf = <T>(lanes: Map<string, ReturnType<typeof lane<T>>>, work: string,
    apply: (choice: T, round: Round) => Promise<boolean>) => {
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
    tracking: shelfFollowing(mainTrackingApi(actingSubject, main), work => void refresh(work).catch(() => null)),
    setStatus: (work: string, status: ReadingStatus | null) =>
      laneOf(statusLanes, work, (choice, round) => writeStatus(work, choice, round)).submit(status),
    rate: ratingTarget ? (work: string, value: number | null) => work !== ratingTarget.work ? Promise.resolve(false)
      : laneOf(ratingLanes, work, (choice, round) => writeRating(ratingTarget, choice, round)).submit(value) : null,
    async refresh(work: string) {
      const server = await refresh(work).catch(() => null);
      const waiting = unapplied.get(work);
      if (waiting && server && (server.rating?.revision ?? null) !== waiting.baseRevision
        && (server.rating?.value ?? null) === waiting.value) unapplied.delete(work);
      notify();
    },
    connect() {
      // Strict-mode effects run twice: a connection after a disconnection starts a fresh lifetime.
      if (!alive()) closing = new AbortController();
      return () => {
        closing.abort();
        for (const lanes of [statusLanes, ratingLanes]) for (const one of lanes.values()) one.cancel();
        statusLanes.clear();
        ratingLanes.clear();
        unapplied.clear();
      };
    },
  };
}
