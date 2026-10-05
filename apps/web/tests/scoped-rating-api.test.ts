import { expect, test } from 'bun:test';
import type { MainClient } from '../features/discover/types.ts';
import { mainScopedRatingApi } from '../features/scoped-rating/api.ts';
import * as fixture from '../features/scoped-rating/fixtures.ts';
import { readingPositionSource, staticFrameSource } from '../features/scoped-rating/sources.ts';

type Call = { name: string; body?: unknown; query?: unknown; key?: string };
const player = 'https://rezics.com/id/019a5c00-0000-7000-8000-0000000000aa';
const place = fixture.placeEpisode3;

/** A Main client that records what the adapter sent and answers with queued responses. */
function fakeMain(answers: Record<string, unknown[]>) {
  const calls: Call[] = [];
  const next = (name: string) => {
    const queue = answers[name] ?? [];
    return (queue.length > 1 ? queue.shift() : queue[0]) as { data?: unknown; error?: { status: number } };
  };
  const post = (name: string) => async (body: unknown, options?: { headers?: Record<string, string> }) => {
    calls.push({ name, body, key: options?.headers?.['idempotency-key'] });
    return { data: null, error: null, ...next(name) };
  };
  const get = (name: string) => async (options?: { query?: unknown }) => {
    calls.push({ name, query: options?.query });
    return { data: null, error: null, ...next(name) };
  };
  const resources = Object.assign((_: { resource: string }) => ({ 'rating-contexts': { get: get('questions') }, ratings: { get: get('rating') } }),
    { summaries: { post: post('summaries') } });
  const main = { v1: { projections: { post: post('projection'), get: get('projections') }, resources,
    'rating-observations': { post: post('observation') }, 'rating-rollups': { post: post('rollup') } } } as unknown as MainClient;
  return { main: () => main, calls };
}

const write = (created: boolean) => ({ data: { projection: place.projection, created, replayed: false, sourcePosition: {} } });
const summaries = { data: { summaries: [place.summary] } };

test('first use gets or creates the one place and reads its summary for the header', async () => {
  const { main, calls } = fakeMain({ projection: [write(true)], summaries: [summaries] });
  const api = mainScopedRatingApi({ actingSubject: player, main });
  const answer = await api.projection(fixture.subject.iri, [fixture.episodes[2]!.iri]);
  expect(answer).toMatchObject({ ok: true, data: { created: true, projection: { id: place.projection.id } } });
  expect(calls[0]).toMatchObject({ name: 'projection', body: { subject: fixture.subject.iri, frames: [fixture.episodes[2]!.iri], actingSubject: player } });
  expect(calls[0]?.key).toMatch(/^[0-9a-f-]{36}$/);
  expect(calls[1]).toMatchObject({ name: 'summaries', body: { resources: [place.projection.id], actingSubject: player } });
});

test('a first use still settling is asked again under the same key until Main answers with the place', async () => {
  const pending = { data: { operationId: 'op', status: 'reconciling', phase: 'projection', result: null, retry: { allowed: true, afterMs: 0 } } };
  const { main, calls } = fakeMain({ projection: [pending, pending, write(false)], summaries: [summaries] });
  const answer = await mainScopedRatingApi({ actingSubject: player, main }).projection(fixture.subject.iri, [fixture.episodes[2]!.iri]);
  expect(answer.ok).toBe(true);
  const keys = calls.filter(call => call.name === 'projection').map(call => call.key);
  expect(keys).toHaveLength(3);
  expect(new Set(keys).size).toBe(1);
});

test('a conflict while creating is asked again once as a new command; a refusal is reported as it is', async () => {
  const conflicted = fakeMain({ projection: [{ error: { status: 409 } }, write(true)], summaries: [summaries] });
  expect((await mainScopedRatingApi({ actingSubject: player, main: conflicted.main })
    .projection(fixture.subject.iri, [fixture.episodes[2]!.iri])).ok).toBe(true);
  const keys = conflicted.calls.filter(call => call.name === 'projection').map(call => call.key);
  expect(new Set(keys).size).toBe(2);
  const refused = fakeMain({ projection: [{ error: { status: 422 } }] });
  expect(await mainScopedRatingApi({ actingSubject: player, main: refused.main })
    .projection(fixture.subject.iri, [fixture.episodes[2]!.iri])).toEqual({ ok: false, failure: 'invalid' });
});

test('opening a place looks it up by its exact frames and creates nothing', async () => {
  const frames = [fixture.episodes[2]!.iri, fixture.continuities[0]!.iri];
  const found = fakeMain({ projections: [{ data: { items: [place.projection], nextCursor: null } }], summaries: [summaries] });
  const answer = await mainScopedRatingApi({ actingSubject: player, main: found.main }).lookup(fixture.subject.iri, frames);
  expect(answer).toMatchObject({ ok: true, data: { projection: { id: place.projection.id }, summary: { status: 'available' } } });
  expect(found.calls[0]).toMatchObject({ name: 'projections', query: { subject: fixture.subject.iri, frames, actingSubject: player } });
  expect(found.calls.map(call => call.name)).not.toContain('projection');
  // A place nobody has rated, or one the reader may not see, is simply not there; nothing is made for it.
  const none = fakeMain({ projections: [{ data: { items: [], nextCursor: null } }] });
  expect(await mainScopedRatingApi({ actingSubject: null, main: none.main }).lookup(fixture.subject.iri, frames))
    .toEqual({ ok: true, data: null });
  expect(none.calls.map(call => call.name)).toEqual(['projections']);
  expect(none.calls[0]?.query).not.toHaveProperty('actingSubject');
});

test('a lookup that fails is a failure to retry, never "no such place"', async () => {
  const down = fakeMain({ projections: [{ error: { status: 503 } }] });
  expect(await mainScopedRatingApi({ actingSubject: player, main: down.main }).lookup(fixture.subject.iri, [fixture.episodes[2]!.iri]))
    .toEqual({ ok: false, failure: 'unavailable' });
});

test('a place whose summary cannot be read comes back without one, so no view calls it hidden', async () => {
  const lost = fakeMain({ projections: [{ data: { items: [place.projection], nextCursor: null } }], summaries: [{ error: { status: 503 } }] });
  const api = mainScopedRatingApi({ actingSubject: player, main: lost.main });
  expect(await api.lookup(fixture.subject.iri, [fixture.episodes[2]!.iri])).toMatchObject({ ok: true, data: { summary: null } });
  expect(await api.projections(fixture.subject.iri)).toMatchObject({ ok: true, data: { items: [{ summary: null }] } });
});

test('a frame set across two Works is its own refusal, and the other 422s stay invalid', async () => {
  const body = (code: string) => ({ error: { status: 422, value: { code } } });
  const mixed = fakeMain({ projection: [body('projection_frame_work_mismatch')] });
  expect(await mainScopedRatingApi({ actingSubject: player, main: mixed.main })
    .projection(fixture.subject.iri, [fixture.episodes[2]!.iri])).toEqual({ ok: false, failure: 'work-mismatch' });
  const repeated = fakeMain({ projection: [body('projection_frame_slot_repeated')] });
  expect(await mainScopedRatingApi({ actingSubject: player, main: repeated.main })
    .projection(fixture.subject.iri, [fixture.episodes[2]!.iri])).toEqual({ ok: false, failure: 'invalid' });
});

test('signed out, nothing is written and the answer says to sign in', async () => {
  const { main, calls } = fakeMain({});
  const api = mainScopedRatingApi({ actingSubject: null, main });
  expect(await api.projection(fixture.subject.iri, [fixture.episodes[2]!.iri])).toEqual({ ok: false, failure: 'sign-in' });
  expect(await api.rate(place.projection.id, fixture.writing.context, 8)).toEqual({ ok: false, failure: 'sign-in' });
  expect(calls).toEqual([]);
});

const saved = (revision: string) => ({ data: { profile: 'realm-target-rating-observation-v1', observationRevision: revision } });
const target = place.projection.id;
const question = fixture.writing.context;
const mine = (own: { revisionHead: string; value: number | null } | null) => ({ data: { profile: 'target-rating-read-v1', scope: { kind: 'mine' },
  context: question, status: 'available', targetGrain: 'projection', count: own?.value ? 1 : 0, mean: own?.value ?? null,
  own: own ? { observation: fixture.iri('0b01'), availability: own.value === null ? 'withdrawn' : 'available', ...own } : null } });
const stale = (currentHead: string | null) => ({ error: { status: 409, value: { code: 'stale_head', currentHead } } });
const heads = (calls: Call[]) => calls.filter(call => call.name === 'observation')
  .map(call => (call.body as { expectedRevisionHead: string | null }).expectedRevisionHead);

test('a person’s own rating is read from Main, so a new device shows it without any browser memory', async () => {
  const { main, calls } = fakeMain({ rating: [mine({ revisionHead: fixture.iri('a1'), value: 8 })] });
  const api = mainScopedRatingApi({ actingSubject: player, main });
  expect(await api.own(target, question)).toEqual({ ok: true, data: { value: 8 } });
  expect(calls[0]).toMatchObject({ name: 'rating', query: { scope: 'mine', context: question, actingSubject: player } });
  const withdrawn = fakeMain({ rating: [mine({ revisionHead: fixture.iri('a2'), value: null })] });
  expect(await mainScopedRatingApi({ actingSubject: player, main: withdrawn.main }).own(target, question)).toEqual({ ok: true, data: { value: null } });
  const first = fakeMain({ rating: [mine(null)] });
  expect(await mainScopedRatingApi({ actingSubject: player, main: first.main }).own(target, question)).toEqual({ ok: true, data: { value: null } });
});

test('signed out, nothing is read or written for the person', async () => {
  const { main, calls } = fakeMain({});
  expect(await mainScopedRatingApi({ actingSubject: null, main }).own(target, question)).toEqual({ ok: false, failure: 'sign-in' });
  expect(calls).toEqual([]);
});

test('a rating names the head it replaces and each write has its own key', async () => {
  const { main, calls } = fakeMain({ rating: [mine(null)], observation: [saved(fixture.iri('a1')), saved(fixture.iri('a2'))] });
  const api = mainScopedRatingApi({ actingSubject: player, main });
  expect(await api.rate(target, question, 7)).toEqual({ ok: true, data: { value: 7, pending: false } });
  expect(await api.rate(target, question, 9)).toMatchObject({ ok: true });
  expect(heads(calls)).toEqual([null, fixture.iri('a1')]);
  const bodies = calls.filter(call => call.name === 'observation');
  expect(bodies[0]?.body).toMatchObject({ value: 7, context: question, target });
  expect(bodies[0]?.key).not.toBe(bodies[1]?.key);
});

test('re-rating on a device that has never seen the rating starts from the head Main holds', async () => {
  const { main, calls } = fakeMain({ rating: [mine({ revisionHead: fixture.iri('a1'), value: 5 })], observation: [saved(fixture.iri('a2'))] });
  const api = mainScopedRatingApi({ actingSubject: player, main });
  expect(await api.rate(target, question, 8)).toMatchObject({ ok: true });
  // The read came first: the write is never sent blind.
  expect(calls.map(call => call.name)).toEqual(['rating', 'observation']);
  expect(heads(calls)).toEqual([fixture.iri('a1')]);
});

test('withdrawing a rating keeps the head so it can be given again', async () => {
  const { main, calls } = fakeMain({ rating: [mine(null)], observation: [saved(fixture.iri('a1')), saved(fixture.iri('a2')), saved(fixture.iri('a3'))] });
  const api = mainScopedRatingApi({ actingSubject: player, main });
  await api.rate(target, question, 7);
  await api.rate(target, question, null);
  expect((await api.rate(target, question, 6)).ok).toBe(true);
  expect(heads(calls)).toEqual([null, fixture.iri('a1'), fixture.iri('a2')]);
});

test('a stale write is retried once on the current head Main returns, as a new command', async () => {
  const { main, calls } = fakeMain({ rating: [mine(null)], observation: [stale(fixture.iri('a1')), saved(fixture.iri('a2'))] });
  const api = mainScopedRatingApi({ actingSubject: player, main });
  expect(await api.rate(target, question, 8)).toEqual({ ok: true, data: { value: 8, pending: false } });
  expect(heads(calls)).toEqual([null, fixture.iri('a1')]);
  const keys = calls.filter(call => call.name === 'observation').map(call => call.key);
  expect(new Set(keys).size).toBe(2);
  // The next write starts from the head the retry left, with no further read.
  await mainScopedRatingApi({ actingSubject: player, main }).rate(target, question, 4);
});

test('a rating changed elsewhere again is reported as a conflict after one retry, never overwritten', async () => {
  const { main, calls } = fakeMain({ rating: [mine(null)], observation: [stale(fixture.iri('a1')), stale(fixture.iri('a2'))] });
  const answer = await mainScopedRatingApi({ actingSubject: player, main }).rate(target, question, 8);
  expect(answer).toEqual({ ok: false, failure: 'conflict' });
  expect(heads(calls)).toEqual([null, fixture.iri('a1')]);
});

test('a refusal that names no head is a conflict at once, and any other refusal is reported as it is', async () => {
  const unknown = fakeMain({ rating: [mine(null)], observation: [stale(null)] });
  expect(await mainScopedRatingApi({ actingSubject: player, main: unknown.main }).rate(target, question, 8)).toEqual({ ok: false, failure: 'conflict' });
  expect(heads(unknown.calls)).toEqual([null]);
  const denied = fakeMain({ rating: [mine(null)], observation: [{ error: { status: 403 } }] });
  expect(await mainScopedRatingApi({ actingSubject: player, main: denied.main }).rate(target, question, 8)).toEqual({ ok: false, failure: 'denied' });
  expect(heads(denied.calls)).toEqual([null]);
});

test('a write Access admitted but has not applied is saved as pending, and the next write reads the head again', async () => {
  const { main, calls } = fakeMain({ rating: [mine(null), mine({ revisionHead: fixture.iri('a1'), value: 8 })],
    observation: [{ data: { operationId: 'op', status: 'reconciling' } }, saved(fixture.iri('a2'))] });
  const api = mainScopedRatingApi({ actingSubject: player, main });
  expect(await api.rate(target, question, 8)).toEqual({ ok: true, data: { value: 8, pending: true } });
  expect(await api.rate(target, question, 6)).toMatchObject({ ok: true });
  expect(heads(calls)).toEqual([null, fixture.iri('a1')]);
});

test('questions are read for the scope, and every page of them', async () => {
  const page = (items: unknown[], nextCursor: string | null) => ({ data: { items, nextCursor } });
  const { main, calls } = fakeMain({ questions: [page([fixture.writing], 'c2'), page([fixture.strength], null)] });
  const api = mainScopedRatingApi({ actingSubject: null, main });
  const answer = await api.questions(place.projection.id, { kind: 'realm', realm: fixture.iri('9002') });
  expect(answer).toMatchObject({ ok: true, data: [{ context: fixture.writing.context }, { context: fixture.strength.context }] });
  expect(calls[0]?.query).toMatchObject({ scope: 'realm', realm: fixture.iri('9002') });
  expect(calls[1]?.query).toMatchObject({ cursor: 'c2' });
});

test('a rating read for a target with no question is refused as invalid rather than shown as a Work rating', async () => {
  const { main } = fakeMain({ rating: [{ data: { profile: 'work-rating-read-v1', count: 3 } }] });
  expect(await mainScopedRatingApi({ actingSubject: null, main })
    .rating(place.projection.id, fixture.writing.context, { kind: 'global' })).toEqual({ ok: false, failure: 'invalid' });
});

test('a roll-up is requested for one question and its formula, acting as the reader', async () => {
  const { main, calls } = fakeMain({ rollup: [{ data: { profile: 'rating-rollup-v1' } }] });
  await mainScopedRatingApi({ actingSubject: player, main })
    .rollup(fixture.writing.context, [place.projection.id], 'mean-of-means', true);
  expect(calls[0]?.body).toEqual({ profile: 'rating-rollup-v1', context: fixture.writing.context, targets: [place.projection.id],
    formula: 'mean-of-means', rank: true, actingSubject: player });
});

test('an unreachable Main is a failure to retry, not an exception', async () => {
  const main = (() => { throw new Error('offline'); }) as unknown as () => MainClient;
  expect(await mainScopedRatingApi({ actingSubject: null, main }).questions(place.projection.id, { kind: 'global' }))
    .toEqual({ ok: false, failure: 'unavailable' });
});

test('a static source is searched by name and offers only the kind of place it was made for', async () => {
  const source = staticFrameSource('position', fixture.episodes, 'Episodes');
  const all = await source.load({ q: '', cursor: null });
  expect(all.items).toHaveLength(fixture.episodes.length);
  expect(all.items.every(item => item.candidate.dimension === 'position')).toBe(true);
  const found = await source.load({ q: 'hunsford', cursor: null });
  expect(found.items.map(item => item.value)).toEqual([fixture.episodes[2]!.iri]);
});

test('the chapters or episodes Main lists become position frames, in the language Main labelled them', async () => {
  const occurrence = fixture.iri('0c01');
  const page = { items: [{ occurrence, ordinal: 3, displayLabel: 'Chapter 3',
    labels: [{ value: '第三章', language: 'zh-Hans' }] }], nextCursor: null, complete: true, search: { status: 'current' } };
  let query: Record<string, unknown> | undefined;
  const main = (() => ({ v1: { 'reading-positions': () => ({ get: async (options: { query: Record<string, unknown> }) => {
    query = options.query;
    return { data: page, error: null };
  } }) } })) as unknown as () => MainClient;
  const source = readingPositionSource({ work: fixture.iri('0c00'), position: 'all', locale: 'zh-Hans', main });
  const loaded = await source.load({ q: '', cursor: null });
  expect(loaded).toMatchObject({ complete: true, nextCursor: null, updating: false });
  expect(query).toMatchObject({ position: 'all', language: 'zh-Hans' });
  expect(loaded.items[0]).toMatchObject({ value: occurrence, label: '第三章',
    candidate: { iri: occurrence, dimension: 'position', name: { value: '第三章', language: 'zh-Hans', direction: 'ltr' } } });
});
