import { expect, test } from 'bun:test';
import { saveDisplayPreference } from '../features/api/preferences.ts';
import type { ReadingStatus } from '../features/catalogue/reader-actions.tsx';
import { createReaderStore, READ_BACK_DELAYS_MS, type ReaderSeed } from '../features/catalogue/reader-store.ts';
import type { MainClient } from '../features/discover/types.ts';

const person = 'https://rezics.com/id/019a5c00-0000-7000-8000-0000000000aa';
const work = 'https://rezics.com/id/019a5c00-0000-7000-8000-000000000001';
const target = { work, context: 'https://rezics.com/id/019a5c00-0000-7000-8000-0000000000c1',
  mainVersion: 'https://rezics.com/id/019a5c00-0000-7000-8000-0000000000d1', max: 5 };

/** A promise settled from outside, so a test decides the order Main's answers arrive in. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

type Gate = { before?: Promise<unknown> };

/**
 * A Main holding one Work's shelf status (with its version) and global rating (with its head). Writes compare and set
 * as Main does; `gates` hold a write's answer until a test releases it, `applyAfterReads` keeps an admitted rating
 * unapplied (a 202) for that many reads of the reader state.
 */
function fakeMain(initial: { status?: ReadingStatus | null; rating?: { value: number; revision: string } | null } = {}) {
  const state = { status: initial.status ?? null, version: 1, rating: initial.rating ?? null };
  const statusWrites: { status: ReadingStatus | null; expectedVersion: number; outcome: number }[] = [];
  const ratingWrites: { value: number | null; head: string | null; outcome: number }[] = [];
  let writing = 0;
  let overlapped = false;
  const gates: Gate[] = [];
  let admitted: { value: number | null; revision: string; after: number } | null = null;
  let reads = 0;
  const control = { applyAfterReads: 0, reads: () => reads, conflictNext: 0 };
  const readerState = () => ({
    status: { status: state.status, version: state.version },
    rating: { global: state.rating ? { availability: 'available', value: state.rating.value, revision: state.rating.revision } : null },
  });
  const enter = async () => {
    writing += 1;
    if (writing > 1) overlapped = true;
    const gate = gates.shift();
    if (gate?.before) await gate.before;
  };
  const main = { v1: {
    works: () => ({
      'reader-state': { get: async () => {
        reads += 1;
        if (admitted && reads > admitted.after) {
          state.rating = admitted.value === null ? null : { value: admitted.value, revision: admitted.revision };
          admitted = null;
        }
        return { data: readerState(), error: null };
      } },
      'reader-status': { put: async (body: { status: ReadingStatus | null; expectedVersion: number }) => {
        await enter();
        try {
          const conflict = body.expectedVersion !== state.version;
          statusWrites.push({ ...body, outcome: conflict ? 409 : 200 });
          if (conflict) return { data: null, error: { status: 409 } };
          state.status = body.status;
          state.version += 1;
          return { data: { status: state.status, version: state.version }, error: null };
        } finally { writing -= 1; }
      } },
    }),
    'global-rating-observations': { post: async (body: { value: number | null; expectedRevisionHead: string | null }) => {
      await enter();
      try {
        const conflict = body.expectedRevisionHead !== (state.rating?.revision ?? null);
        const outcome = conflict ? 409 : control.applyAfterReads > 0 || control.applyAfterReads === -1 ? 202 : 200;
        ratingWrites.push({ value: body.value, head: body.expectedRevisionHead, outcome });
        if (conflict) return { data: null, error: { status: 409 } };
        const revision = `r${ratingWrites.length}`;
        if (outcome === 202) {
          admitted = { value: body.value, revision, after: control.applyAfterReads === -1 ? Infinity : reads + control.applyAfterReads };
          return { data: { retry: { afterMs: 0 } }, error: null };
        }
        state.rating = body.value === null ? null : { value: body.value, revision };
        return { data: { observationRevision: revision }, error: null };
      } finally { writing -= 1; }
    } },
  } } as unknown as MainClient;
  return { main: () => main, state, statusWrites, ratingWrites, gates, control, overlapped: () => overlapped,
    /** Another device sets the status first. */
    elsewhere(status: ReadingStatus | null) { state.status = status; state.version += 1; },
    /** Another device rates first. */
    rateElsewhere(value: number) { state.rating = { value, revision: `other${state.version}` }; },
    /** Main applies a rating it had admitted. */
    apply() { if (admitted) { state.rating = admitted.value === null ? null : { value: admitted.value, revision: admitted.revision }; admitted = null; } } };
}

const entry = (status: ReadingStatus | null, rating: { value: number; revision: string } | null = null): ReaderSeed =>
  ({ [work]: { status, version: 1, rating } });
const instant = () => Promise.resolve();
const storeOver = (fake: ReturnType<typeof fakeMain>, seed: ReaderSeed = entry(null)) =>
  createReaderStore({ actingSubject: person, seed, ratingTarget: target, main: fake.main, wait: instant });

test('write intent: two overlapping shelf choices are written one at a time and the newest stands', async () => {
  const fake = fakeMain();
  const release = deferred<void>();
  fake.gates.push({ before: release.promise });
  const store = storeOver(fake);
  const first = store.setStatus(work, 'reading');
  await tick();
  // A second and a third choice are made while the first is still being written.
  const second = store.setStatus(work, 'read');
  const third = store.setStatus(work, 'want-to-read');
  release.resolve();
  expect(await Promise.all([first, second, third])).toEqual([true, true, true]);
  // The older write's answer arrived last of all the choices made, and still did not overwrite the newest.
  expect(fake.state.status).toBe('want-to-read');
  expect(store.stateOf(work).status).toBe('want-to-read');
  expect(fake.statusWrites.map(write => write.status)).toEqual(['reading', 'want-to-read']);
  expect(fake.overlapped()).toBe(false);
});

test('write intent: a 409 after a newer local choice does not replay the older one', async () => {
  const fake = fakeMain();
  const release = deferred<void>();
  fake.gates.push({ before: release.promise });
  const store = storeOver(fake);
  // Another device moved the status first, so the first write is stale.
  fake.elsewhere('read');
  const first = store.setStatus(work, 'reading');
  await tick();
  const newer = store.setStatus(work, 'want-to-read');
  release.resolve();
  await Promise.all([first, newer]);
  expect(fake.state.status).toBe('want-to-read');
  expect(fake.statusWrites.filter(write => write.status === 'reading').map(write => write.outcome)).toEqual([409]);
  expect(fake.statusWrites.map(write => `${write.status}:${write.outcome}`)).toEqual(['reading:409', 'want-to-read:200']);
});

test('write intent: after a 409 the choice is applied once on the fresh version, and not at all when Main already holds it', async () => {
  const stale = fakeMain();
  stale.elsewhere('read');
  const store = storeOver(stale);
  expect(await store.setStatus(work, 'reading')).toBe(true);
  expect(stale.state.status).toBe('reading');
  expect(stale.statusWrites.map(write => write.outcome)).toEqual([409, 200]);

  const held = fakeMain();
  held.elsewhere('reading');
  expect(await storeOver(held).setStatus(work, 'reading')).toBe(true);
  expect(held.statusWrites.map(write => write.outcome)).toEqual([409]);
  expect(held.state.status).toBe('reading');
});

test('write intent: overlapping ratings are written in turn with the head each replaces', async () => {
  const fake = fakeMain({ rating: { value: 2, revision: 'r0' } });
  const release = deferred<void>();
  fake.gates.push({ before: release.promise });
  const store = storeOver(fake, entry(null, { value: 2, revision: 'r0' }));
  const first = store.rate!(work, 3);
  await tick();
  const second = store.rate!(work, 4);
  const third = store.rate!(work, 5);
  release.resolve();
  await Promise.all([first, second, third]);
  expect(fake.ratingWrites.map(write => write.value)).toEqual([3, 5]);
  expect(fake.ratingWrites[1]!.head).toBe('r1');
  expect(fake.state.rating?.value).toBe(5);
  expect(store.stateOf(work).rating).toBe(5);
  expect(fake.overlapped()).toBe(false);
});

test('write intent: a rating 409 re-applies only the newest choice, and only when it differs from Main', async () => {
  const fake = fakeMain({ rating: { value: 2, revision: 'r0' } });
  const release = deferred<void>();
  fake.gates.push({ before: release.promise });
  const store = storeOver(fake, entry(null, { value: 2, revision: 'r0' }));
  fake.rateElsewhere(4);
  const first = store.rate!(work, 3);
  await tick();
  const newer = store.rate!(work, 5);
  release.resolve();
  await Promise.all([first, newer]);
  expect(fake.state.rating?.value).toBe(5);
  expect(fake.ratingWrites.map(write => `${write.value}:${write.outcome}`)).toEqual(['3:409', '5:200']);

  const held = fakeMain({ rating: { value: 2, revision: 'r0' } });
  const alone = storeOver(held, entry(null, { value: 2, revision: 'r0' }));
  held.rateElsewhere(3);
  expect(await alone.rate!(work, 3)).toBe(true);
  expect(held.ratingWrites.map(write => write.outcome)).toEqual([409]);
});

test('write intent: an admitted rating shows as pending, is read back, then shows the settled value', async () => {
  const fake = fakeMain();
  fake.control.applyAfterReads = 2;
  const seen: (string | undefined)[] = [];
  const store = storeOver(fake);
  store.subscribe?.(() => seen.push(store.stateOf(work).ratingWrite));
  expect(await store.rate!(work, 4)).toBe(true);
  expect(store.stateOf(work)).toEqual({ status: null, rating: 4 });
  // While it was read back the control was told it is pending, with the chosen value.
  expect(seen).toContain('pending');
  expect(seen.at(-1)).toBeUndefined();
  // Read back a bounded number of times: two reads before Main applied it, one more that saw it.
  expect(fake.control.reads()).toBe(3);
});

test('write intent: an admitted rating that never appears says it is still processing, and a refresh settles it later', async () => {
  const fake = fakeMain();
  fake.control.applyAfterReads = -1;
  const store = storeOver(fake);
  expect(await store.rate!(work, 4)).toBe(true);
  expect(store.stateOf(work)).toMatchObject({ rating: 4, ratingWrite: 'unsettled' });
  // Bounded: one read per back-off delay, never more.
  expect(fake.control.reads()).toBe(READ_BACK_DELAYS_MS.length);
  const before = fake.control.reads();
  await store.refresh!(work);
  expect(fake.control.reads()).toBe(before + 1);
  expect(store.stateOf(work).ratingWrite).toBe('unsettled');
  fake.apply();
  await store.refresh!(work);
  expect(store.stateOf(work)).toEqual({ status: null, rating: 4 });
});

test('write intent: a newer rating made while one is pending is not held behind the rest of its read-back', async () => {
  const fake = fakeMain();
  fake.control.applyAfterReads = -1;
  const holds: ReturnType<typeof deferred<void>>[] = [];
  const store = createReaderStore({ actingSubject: person, seed: entry(null), ratingTarget: target, main: fake.main,
    wait: () => { const hold = deferred<void>(); holds.push(hold); return hold.promise; } });
  const first = store.rate!(work, 3);
  await tick();
  expect(store.stateOf(work)).toMatchObject({ rating: 3, ratingWrite: 'pending' });
  fake.control.applyAfterReads = 0;
  const second = store.rate!(work, 5);
  holds[0]!.resolve();
  expect(await Promise.all([first, second])).toEqual([true, true]);
  expect(holds).toHaveLength(1);
  expect(fake.ratingWrites.map(write => write.value)).toEqual([3, 5]);
  expect(store.stateOf(work)).toEqual({ status: null, rating: 5 });
});

function accountOver(initial = { revision: 0, displayMode: 'system', showZoneThemes: true }) {
  const account = { ...initial };
  const writes: { body: { expectedRevision: number; displayMode: string; showZoneThemes: boolean }; status: number }[] = [];
  const gates: Promise<unknown>[] = [];
  let writing = 0;
  let overlapped = false;
  const fetcher = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method !== 'PUT') return Response.json({ ...account });
    writing += 1;
    if (writing > 1) overlapped = true;
    const gate = gates.shift();
    if (gate) await gate;
    const body = JSON.parse(String(init.body));
    const conflict = body.expectedRevision !== account.revision;
    writes.push({ body, status: conflict ? 409 : 200 });
    writing -= 1;
    if (conflict) return Response.json({ error: 'conflict' }, { status: 409 });
    Object.assign(account, { revision: account.revision + 1, displayMode: body.displayMode, showZoneThemes: body.showZoneThemes });
    return Response.json({ ...account });
  }) as typeof fetch;
  return { account, writes, gates, fetcher, overlapped: () => overlapped };
}

test('write intent: overlapping appearance choices are written in turn and the newest stands', async () => {
  const site = accountOver();
  const release = deferred<void>();
  site.gates.push(release.promise);
  const first = saveDisplayPreference({ displayMode: 'dark' }, site.fetcher);
  await tick();
  const second = saveDisplayPreference({ displayMode: 'light' }, site.fetcher);
  const third = saveDisplayPreference({ displayMode: 'system', showZoneThemes: false }, site.fetcher);
  release.resolve();
  expect(await Promise.all([first, second, third])).toEqual(['saved', 'saved', 'saved']);
  expect(site.account).toMatchObject({ displayMode: 'system', showZoneThemes: false });
  expect(site.writes.map(write => write.body.displayMode)).toEqual(['dark', 'system']);
  expect(site.overlapped()).toBe(false);
});

test('write intent: a competing account update does not make an older appearance choice overwrite a newer one', async () => {
  const site = accountOver();
  const release = deferred<void>();
  site.gates.push(release.promise);
  const first = saveDisplayPreference({ displayMode: 'dark' }, site.fetcher);
  await tick();
  // Another device wrote while this one's write was on its way, so it will be refused as stale.
  Object.assign(site.account, { revision: 1, displayMode: 'light' });
  const newer = saveDisplayPreference({ displayMode: 'system' }, site.fetcher);
  release.resolve();
  expect(await Promise.all([first, newer])).toEqual(['saved', 'saved']);
  expect(site.account.displayMode).toBe('system');
  expect(site.writes.map(write => `${write.body.displayMode}:${write.status}`)).toEqual(['dark:409', 'system:200']);
});

test('write intent: an appearance choice Main already holds after a competing update is not written again', async () => {
  const site = accountOver();
  const release = deferred<void>();
  site.gates.push(release.promise);
  const only = saveDisplayPreference({ displayMode: 'dark' }, site.fetcher);
  await tick();
  Object.assign(site.account, { revision: 1, displayMode: 'dark' });
  release.resolve();
  expect(await only).toBe('saved');
  expect(site.writes.map(write => write.status)).toEqual([409]);
  expect(site.account.displayMode).toBe('dark');
});
