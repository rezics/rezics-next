import { expect, test } from 'bun:test';
import type { MainClient } from '../features/discover/types.ts';
import { mainScopedRatingApi, memoryOwnRatings } from '../features/scoped-rating/api.ts';
import * as fixture from '../features/scoped-rating/fixtures.ts';

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
  const api = mainScopedRatingApi({ actingSubject: player, own: memoryOwnRatings(), main });
  const answer = await api.projection(fixture.subject.iri, [fixture.episodes[2]!.iri]);
  expect(answer).toMatchObject({ ok: true, data: { created: true, projection: { id: place.projection.id } } });
  expect(calls[0]).toMatchObject({ name: 'projection', body: { subject: fixture.subject.iri, frames: [fixture.episodes[2]!.iri], actingSubject: player } });
  expect(calls[0]?.key).toMatch(/^[0-9a-f-]{36}$/);
  expect(calls[1]).toMatchObject({ name: 'summaries', body: { resources: [place.projection.id], actingSubject: player } });
});

test('a first use still settling is asked again under the same key until Main answers with the place', async () => {
  const pending = { data: { operationId: 'op', status: 'reconciling', phase: 'projection', result: null, retry: { allowed: true, afterMs: 0 } } };
  const { main, calls } = fakeMain({ projection: [pending, pending, write(false)], summaries: [summaries] });
  const answer = await mainScopedRatingApi({ actingSubject: player, own: memoryOwnRatings(), main }).projection(fixture.subject.iri, [fixture.episodes[2]!.iri]);
  expect(answer.ok).toBe(true);
  const keys = calls.filter(call => call.name === 'projection').map(call => call.key);
  expect(keys).toHaveLength(3);
  expect(new Set(keys).size).toBe(1);
});

test('a conflict while creating is asked again once as a new command; a refusal is reported as it is', async () => {
  const conflicted = fakeMain({ projection: [{ error: { status: 409 } }, write(true)], summaries: [summaries] });
  expect((await mainScopedRatingApi({ actingSubject: player, own: memoryOwnRatings(), main: conflicted.main })
    .projection(fixture.subject.iri, [fixture.episodes[2]!.iri])).ok).toBe(true);
  const keys = conflicted.calls.filter(call => call.name === 'projection').map(call => call.key);
  expect(new Set(keys).size).toBe(2);
  const refused = fakeMain({ projection: [{ error: { status: 422 } }] });
  expect(await mainScopedRatingApi({ actingSubject: player, own: memoryOwnRatings(), main: refused.main })
    .projection(fixture.subject.iri, [fixture.episodes[2]!.iri])).toEqual({ ok: false, failure: 'invalid' });
});

test('signed out, nothing is written and the answer says to sign in', async () => {
  const { main, calls } = fakeMain({});
  const api = mainScopedRatingApi({ actingSubject: null, own: memoryOwnRatings(), main });
  expect(await api.projection(fixture.subject.iri, [fixture.episodes[2]!.iri])).toEqual({ ok: false, failure: 'sign-in' });
  expect(await api.rate(place.projection.id, fixture.writing.context, 8)).toEqual({ ok: false, failure: 'sign-in' });
  expect(calls).toEqual([]);
});

const saved = (revision: string) => ({ data: { profile: 'realm-target-rating-observation-v1', observationRevision: revision } });

test('a rating names the head it replaces and each write has its own key', async () => {
  const { main, calls } = fakeMain({ observation: [saved(fixture.iri('a1')), saved(fixture.iri('a2'))] });
  const own = memoryOwnRatings();
  const api = mainScopedRatingApi({ actingSubject: player, own, main });
  expect(await api.rate(place.projection.id, fixture.writing.context, 7)).toEqual({ ok: true, data: { value: 7, pending: false } });
  expect(await api.rate(place.projection.id, fixture.writing.context, 9)).toMatchObject({ ok: true });
  const bodies = calls.map(call => call.body as { expectedRevisionHead: string | null; value: number; context: string; target: string });
  expect(bodies[0]).toMatchObject({ expectedRevisionHead: null, value: 7, context: fixture.writing.context, target: place.projection.id });
  expect(bodies[1]).toMatchObject({ expectedRevisionHead: fixture.iri('a1'), value: 9 });
  expect(calls[0]?.key).not.toBe(calls[1]?.key);
  expect(api.own(place.projection.id, fixture.writing.context)).toBe(9);
});

test('withdrawing a rating keeps the head so it can be given again', async () => {
  const { main } = fakeMain({ observation: [saved(fixture.iri('a1')), saved(fixture.iri('a2')), saved(fixture.iri('a3'))] });
  const api = mainScopedRatingApi({ actingSubject: player, own: memoryOwnRatings(), main });
  await api.rate(place.projection.id, fixture.writing.context, 7);
  await api.rate(place.projection.id, fixture.writing.context, null);
  expect(api.own(place.projection.id, fixture.writing.context)).toBeNull();
  const again = await api.rate(place.projection.id, fixture.writing.context, 6);
  expect(again.ok).toBe(true);
});

test('a write another press on this device settled first is applied again on the head it left', async () => {
  const own = memoryOwnRatings();
  const { main, calls } = fakeMain({ observation: [{ error: { status: 409 } }, saved(fixture.iri('a2'))] });
  // The other press landed between the read of the head and the answer.
  const original = main;
  let first = true;
  const racing = () => {
    const client = original();
    const post = client.v1['rating-observations'].post;
    client.v1['rating-observations'].post = (async (...args: Parameters<typeof post>) => {
      if (first) { first = false; own.set(player, fixture.writing.context, place.projection.id, { value: 5, revision: fixture.iri('a1') }); }
      return post(...args);
    }) as typeof post;
    return client;
  };
  const answer = await mainScopedRatingApi({ actingSubject: player, own, main: racing }).rate(place.projection.id, fixture.writing.context, 8);
  expect(answer.ok).toBe(true);
  expect(calls.map(call => (call.body as { expectedRevisionHead: string | null }).expectedRevisionHead)).toEqual([null, fixture.iri('a1')]);
});

test('a rating changed elsewhere is reported as a conflict, never overwritten', async () => {
  const own = memoryOwnRatings({ [`${player}\n${fixture.writing.context}\n${place.projection.id}`]: { value: 5, revision: fixture.iri('a1') } });
  const { main, calls } = fakeMain({ observation: [{ error: { status: 409 } }] });
  const answer = await mainScopedRatingApi({ actingSubject: player, own, main }).rate(place.projection.id, fixture.writing.context, 8);
  expect(answer).toEqual({ ok: false, failure: 'conflict' });
  expect(calls).toHaveLength(1);
  // The value on screen stays the one Main last confirmed.
  expect(own.get(player, fixture.writing.context, place.projection.id)?.value).toBe(5);
});

test('a write Access admitted but has not applied is saved as pending', async () => {
  const { main } = fakeMain({ observation: [{ data: { operationId: 'op', status: 'reconciling' } }] });
  const own = memoryOwnRatings();
  expect(await mainScopedRatingApi({ actingSubject: player, own, main }).rate(place.projection.id, fixture.writing.context, 8))
    .toEqual({ ok: true, data: { value: 8, pending: true } });
  expect(own.get(player, fixture.writing.context, place.projection.id)).toBeNull();
});

test('questions are read for the scope, and every page of them', async () => {
  const page = (items: unknown[], nextCursor: string | null) => ({ data: { items, nextCursor } });
  const { main, calls } = fakeMain({ questions: [page([fixture.writing], 'c2'), page([fixture.strength], null)] });
  const api = mainScopedRatingApi({ actingSubject: null, own: memoryOwnRatings(), main });
  const answer = await api.questions(place.projection.id, { kind: 'realm', realm: fixture.iri('9002') });
  expect(answer).toMatchObject({ ok: true, data: [{ context: fixture.writing.context }, { context: fixture.strength.context }] });
  expect(calls[0]?.query).toMatchObject({ scope: 'realm', realm: fixture.iri('9002') });
  expect(calls[1]?.query).toMatchObject({ cursor: 'c2' });
});

test('a rating read for a target with no question is refused as invalid rather than shown as a Work rating', async () => {
  const { main } = fakeMain({ rating: [{ data: { profile: 'work-rating-read-v1', count: 3 } }] });
  expect(await mainScopedRatingApi({ actingSubject: null, own: memoryOwnRatings(), main })
    .rating(place.projection.id, fixture.writing.context, { kind: 'global' })).toEqual({ ok: false, failure: 'invalid' });
});

test('a roll-up is requested for one question and its formula, acting as the reader', async () => {
  const { main, calls } = fakeMain({ rollup: [{ data: { profile: 'rating-rollup-v1' } }] });
  await mainScopedRatingApi({ actingSubject: player, own: memoryOwnRatings(), main })
    .rollup(fixture.writing.context, [place.projection.id], 'mean-of-means', true);
  expect(calls[0]?.body).toEqual({ profile: 'rating-rollup-v1', context: fixture.writing.context, targets: [place.projection.id],
    formula: 'mean-of-means', rank: true, actingSubject: player });
});

test('an unreachable Main is a failure to retry, not an exception', async () => {
  const main = (() => { throw new Error('offline'); }) as unknown as () => MainClient;
  expect(await mainScopedRatingApi({ actingSubject: null, own: memoryOwnRatings(), main }).questions(place.projection.id, { kind: 'global' }))
    .toEqual({ ok: false, failure: 'unavailable' });
});
