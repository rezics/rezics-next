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

/** One Work's reader state as Main last answered, with each field's committed order. */
export interface ReaderEntry {
  status: ReadingStatus | null;
  version: number;
  rating: { value: number | null; revision: string;
    sourcePosition: { datasetId: 'product'; dataEpoch: string; sequence: string } } | null;
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
    rating: own ? { value: own.availability === 'available' ? own.value : null, revision: own.revision,
      sourcePosition: own.sourcePosition } : null };
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
  /** The local sequence number of the choice being written; a newer one settles what an older one left behind. */
  seq: number;
  /** True when a newer choice is waiting behind this one, so it should stop retrying. */
  superseded: () => boolean;
  /** Says the round read what Main holds before it was superseded, so the next round may rely on that reading. */
  confirm: () => void;
  /** True when the previous round was superseded after reading what Main holds, and nothing has changed since. */
  afterConfirmed: boolean;
}

/**
 * One write at a time for one Work and field. A choice made while a write is in flight replaces any choice waiting
 * behind it (the newest wins), and every caller waiting on a replaced choice gets the outcome of the one that stood.
 * `apply` writes one choice; `cancel` drops what is waiting and stops the lane after the write in flight.
 */
function lane<T>(apply: (choice: T, round: Round) => Promise<boolean>) {
  let running = false;
  let cancelled = false;
  let latest: { choice: T; seq: number } | null = null;
  let waiting: ((saved: boolean) => void)[] = [];
  async function run() {
    running = true;
    let afterConfirmed = false;
    while (latest && !cancelled) {
      const { choice, seq } = latest;
      const batch = waiting;
      latest = null;
      waiting = [];
      let confirmed = false;
      const saved = await apply(choice, { seq, afterConfirmed, confirm: () => { confirmed = true; },
        superseded: () => latest !== null || cancelled }).catch(() => false);
      afterConfirmed = confirmed && latest !== null;
      // A newer choice arrived meanwhile: these callers wait for it instead.
      if (latest && !cancelled) waiting = [...batch, ...waiting];
      else for (const resolve of batch) resolve(saved && !cancelled);
    }
    running = false;
  }
  return {
    submit: (choice: T, seq: number) => new Promise<boolean>(resolve => {
      if (cancelled) { resolve(false); return; }
      latest = { choice, seq };
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
type Lane<T> = ReturnType<typeof lane<T>>;

/**
 * A rating write Access admitted but Main has not applied, shown until Main's state shows its value. It belongs to
 * the choice (`seq`) that made it: a newer choice that settles replaces it, and Main showing its value clears it.
 */
interface Overlay {
  value: number | null; seq: number; baseRevision: string | null; state: 'pending' | 'unsettled';
  /** The lifetime that made it; its disposal takes it away. */
  life: Lifetime;
}

/** Reads back an admitted rating this many times, waiting longer each time, before saying it is still processing. */
export const READ_BACK_DELAYS_MS = [400, 800, 1600, 3200] as const;

/** Waits `milliseconds`, or until `signal` aborts; its listener is gone once the wait is over. */
export function pause(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>(resolve => {
    const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, milliseconds);
    signal.addEventListener('abort', done, { once: true });
  });
}

/** One lifetime of the store: from a connection to its disposal. Whatever a lifetime started stops with it. */
interface Lifetime {
  signal: AbortSignal;
  abort: () => void;
  status: Map<string, Lane<ReadingStatus | null>>;
  rating: Map<string, Lane<number | null>>;
}
function lifetime(): Lifetime {
  const controller = new AbortController();
  const lifetime: Lifetime = { signal: controller.signal, status: new Map(), rating: new Map(), abort() {
    controller.abort();
    for (const lanes of [lifetime.status, lifetime.rating]) for (const one of lanes.values()) one.cancel();
  } };
  return lifetime;
}

/**
 * Reader actions over Main, for a signed-in reader acting as `actingSubject`.
 * State starts from the server's seed; Works drawn later ("Show more") are
 * read in batches as they appear. Three rules keep what the person chose:
 *
 * - Writes compare and set, one at a time per Work and field. A choice made while one is being written replaces any
 *   waiting behind it; after a conflict (409) the store reads Main again and applies only the newest choice, and
 *   only if Main does not already hold it.
 * - A response never puts an older value back. A status is applied only at a newer version than the one held. A
 *   rating is applied only at a newer committed revision position in the same dataset epoch. A restore changes
 *   epochs; positions across that boundary cannot be ordered, so a new server seed starts a new store.
 * - What an operation started belongs to the lifetime it started in (`connect()` begins one, its disposal ends it).
 *   After that no write is sent and no read-back is waited for, even if the page is connected again.
 *
 * A rating Access admitted but has not applied is an overlay owned by its choice: shown as pending and read back a
 * bounded number of times, cleared when Main shows its value on a moved head or when a newer choice settles.
 */
export function createReaderStore({ actingSubject, seed = {}, ratingTarget, main = browserMainApi, wait = pause }: {
  actingSubject: string; seed?: ReaderSeed; ratingTarget?: RatingTarget | null; main?: () => MainClient;
  /** Waits between read-backs of a pending rating; tests pass one that returns at once. */
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}): Extract<ReaderActions, { kind: 'ready' }> {
  const entries = new Map(Object.entries(seed));
  const overlays = new Map<string, Overlay>();
  const listeners = new Set<() => void>();
  let version = 0;
  const notify = () => { version += 1; for (const listener of listeners) listener(); };
  // Works already asked for, answered or not: a Work Main did not answer is not asked for again on every render.
  const requested = new Set<string>();
  let queued = new Set<string>();
  let current = lifetime();
  let sequence = 0;

  // Main denied this Agent a reader library: controls withdraw rather than fail on every press.
  let denied = false;

  /** Applies Main's committed order field by field, independent of request or response timing. */
  function merge(work: string, server: ReaderEntry) {
    const held = entries.get(work);
    if (!held) entries.set(work, server);
    else {
      const newerStatus = server.version > held.version;
      const incoming = server.rating?.sourcePosition, previous = held.rating?.sourcePosition;
      // Null means no sealed observation, not a withdrawal. A withdrawal carries its own revision and position.
      const newerRating = incoming && (!previous || incoming.dataEpoch === previous.dataEpoch
        && BigInt(incoming.sequence) > BigInt(previous.sequence));
      entries.set(work, { status: newerStatus ? server.status : held.status,
        version: newerStatus ? server.version : held.version, rating: newerRating ? server.rating : held.rating });
    }
    const accepted = entries.get(work)!.rating;
    const overlay = overlays.get(work);
    if (overlay && accepted && accepted.value === overlay.value
      && accepted.revision !== overlay.baseRevision) overlays.delete(work);
  }
  /** A rating write that took, or was found already held, settles every older choice's overlay. */
  function settleOlder(work: string, seq: number) {
    const overlay = overlays.get(work);
    if (overlay && overlay.seq < seq) overlays.delete(work);
  }

  async function readAll(life: Lifetime, works: string[]) {
    if (life.signal.aborted) return;
    const read = await readReaderSeed(main(), actingSubject, works);
    if (life.signal.aborted) return;
    if (read === null) denied = true;
    for (const [work, entry] of Object.entries(read ?? {})) merge(work, entry);
    notify();
  }
  function load(work: string) {
    // The server render shows the seed; reads for other Works start in the browser.
    if (typeof window === 'undefined' || entries.has(work) || requested.has(work)) return;
    const life = current;
    if (life.signal.aborted) return;
    requested.add(work);
    queued.add(work);
    if (queued.size > 1) return;
    // One batch for every card drawn in the same render.
    queueMicrotask(() => {
      if (life.signal.aborted) return;
      const works = [...queued].filter(item => !entries.has(item));
      queued = new Set();
      if (works.length) void readAll(life, works);
    });
  }
  /** Reads the Work's state and returns what Main answered; the store keeps it only where it is newer than what it holds. */
  async function refresh(work: string, life = current): Promise<ReaderEntry | null> {
    if (life.signal.aborted) return null;
    const { data, error } = await main().v1.works({ id: work.slice(-36) })['reader-state'].get({ query: { actingSubject } });
    if (life.signal.aborted) return null;
    if (error?.status === 403) { denied = true; notify(); }
    if (!data) return null;
    const server = readerEntry(data);
    merge(work, server);
    notify();
    return entries.get(work)!;
  }

  async function writeStatus(life: Lifetime, work: string, status: ReadingStatus | null, round: Round) {
    const api = main().v1.works({ id: work.slice(-36) })['reader-status'];
    const put = (entry: ReaderEntry) => api.put({ actingSubject, expectedVersion: entry.version, status },
      { headers: { 'idempotency-key': crypto.randomUUID() } });
    const base = entries.get(work) ?? await refresh(work, life);
    if (!base || life.signal.aborted) return false;
    // The last round read what Main holds and was superseded by this choice: no write if Main already has it.
    if (round.afterConfirmed && base.status === status) return true;
    let response = await put(base);
    if (life.signal.aborted) return false;
    if (response.error?.status === 409) {
      const fresh = await refresh(work, life);
      if (!fresh || life.signal.aborted) return false;
      // A newer choice is waiting, or Main already holds this one: there is nothing of this choice left to write.
      if (round.superseded()) { round.confirm(); return false; }
      if (fresh.status === status) return true;
      response = await put(fresh);
      if (life.signal.aborted) return false;
    }
    if (!response.data) return false;
    merge(work, { status: response.data.status, version: response.data.version, rating: entries.get(work)?.rating ?? base.rating });
    notify();
    relationshipsChanged();
    return true;
  }

  /** Reads the Work's state again until the overlay of choice `seq` is gone; false if it never is. */
  async function readBack(life: Lifetime, work: string, seq: number, superseded: () => boolean) {
    for (const delay of READ_BACK_DELAYS_MS) {
      await wait(delay, life.signal);
      if (life.signal.aborted) return false;
      // A read that fails is no answer yet: the next one may.
      await refresh(work, life).catch(() => null);
      if (life.signal.aborted) return false;
      if (overlays.get(work)?.seq !== seq) return true;
      if (superseded()) return false;
    }
    return false;
  }

  async function writeRating(life: Lifetime, target: RatingTarget, value: number | null, round: Round) {
    const { work } = target;
    const post = (entry: ReaderEntry) => main().v1['global-rating-observations'].post({
      profile: 'global-rating-standing-observation-v1', context: target.context, work,
      mainVersion: target.mainVersion, expectedRevisionHead: entry.rating?.revision ?? null, value,
      actingSubject }, { headers: { 'idempotency-key': crypto.randomUUID() } });
    const base = entries.get(work) ?? await refresh(work, life);
    if (!base || life.signal.aborted) return false;
    if (round.afterConfirmed && (base.rating?.value ?? null) === value && !overlays.has(work)) { settleOlder(work, round.seq); return true; }
    let from = base;
    let response = await post(from);
    if (life.signal.aborted) return false;
    if (response.error?.status === 409) {
      const fresh = await refresh(work, life);
      if (!fresh || life.signal.aborted) return false;
      if (round.superseded()) { round.confirm(); return false; }
      // Main already holds this value: the choice is settled by what Main shows, and so is any older one's overlay.
      if ((fresh.rating?.value ?? null) === value) { settleOlder(work, round.seq); notify(); return true; }
      from = fresh;
      response = await post(from);
      if (life.signal.aborted) return false;
    }
    if (response.error || !response.data) return false;
    if ('observationRevision' in response.data) {
      merge(work, { ...(entries.get(work) ?? from), rating: { value,
        revision: response.data.observationRevision, sourcePosition: response.data.sourcePosition } });
      settleOlder(work, round.seq);
      notify();
      return true;
    }
    // Admitted but not applied (202): an overlay of this choice until Main's state shows it, never settled by assumption.
    overlays.set(work, { value, seq: round.seq, baseRevision: from.rating?.revision ?? null, state: 'pending', life });
    notify();
    let applied = false;
    try { applied = await readBack(life, work, round.seq, round.superseded); } finally {
      const overlay = overlays.get(work);
      if (overlay?.seq === round.seq) {
        if (applied || life.signal.aborted || round.superseded()) overlays.delete(work);
        else overlays.set(work, { ...overlay, state: 'unsettled' });
      }
      notify();
    }
    return true;
  }

  const laneOf = <T>(lanes: Map<string, Lane<T>>, work: string,
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
      const overlay = overlays.get(work);
      return { status: entry?.status ?? null, rating: overlay ? overlay.value : entry?.rating?.value ?? null,
        ...overlay ? { ratingWrite: overlay.state } : {} };
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    snapshot: () => version,
    available: () => !denied,
    tracking: shelfFollowing(mainTrackingApi(actingSubject, main), work => void refresh(work).catch(() => null)),
    setStatus(work: string, status: ReadingStatus | null) {
      const life = current;
      if (life.signal.aborted) return Promise.resolve(false);
      return laneOf(life.status, work, (choice, round) => writeStatus(life, work, choice, round))
        .submit(status, ++sequence);
    },
    rate: ratingTarget ? (work: string, value: number | null) => {
      const life = current;
      if (work !== ratingTarget.work || life.signal.aborted) return Promise.resolve(false);
      return laneOf(life.rating, work, (choice, round) => writeRating(life, ratingTarget, choice, round))
        .submit(value, ++sequence);
    } : null,
    async refresh(work: string) {
      await refresh(work).catch(() => null);
    },
    connect() {
      // A connection after a disposal (strict-mode effects run twice) begins a new lifetime; the old one stays ended.
      if (current.signal.aborted) current = lifetime();
      const mine = current;
      return () => {
        mine.abort();
        if (mine === current) { requested.clear(); queued = new Set(); }
        for (const [work, overlay] of overlays) if (overlay.life === mine) overlays.delete(work);
        notify();
      };
    },
  };
}
