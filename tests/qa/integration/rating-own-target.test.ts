import { afterAll, beforeAll, expect, test } from 'bun:test';
import { scopedJudgmentsFixture, short, type Opinion } from './scoped-judgments-support.ts';

let h: Awaited<ReturnType<typeof scopedJudgmentsFixture>>;
beforeAll(async () => { h = await scopedJudgmentsFixture(); }, 300_000);
afterAll(async () => { await h?.stop(); });

type Person = typeof h.owner;
interface Own { observation: string; revisionHead: string; availability: string; value: number | null }
interface Read { profile: string; context: string; status: string; count: number; mean: number | null; own?: Own | null }
const mine = (reader: Person | null, target: string, context: string) => h.call(reader, 'GET',
  `/v1/resources/${short(target)}/ratings?scope=mine&context=${encodeURIComponent(context)}${
    reader ? `&actingSubject=${encodeURIComponent(reader.actor)}` : ''}`);
const rate = (rater: Person, context: string, target: string, value: number | null, head: string | null) =>
  h.call(rater, 'POST', '/v1/rating-observations', h.ratingBody(rater, context, target, value, head));

/** A rater's own head and value on the target, read back through the same API a second device would use. */
async function ownIsReadable(target: string, grain: 'projection' | 'resource') {
  const q = await h.question({ targetGrain: grain });
  await h.grant(h.owner, `rating:observe:${q.context}`, 'rating.observation.set');
  const empty = await h.json<Read>(await mine(h.owner, target, q.context));
  expect(empty).toMatchObject({ profile: 'target-rating-read-v1', context: q.context, own: null, count: 0, mean: null });

  const first = await h.json<Opinion>(await rate(h.owner, q.context, target, 8, null), 201);
  const read = await h.json<Read>(await mine(h.owner, target, q.context));
  expect(read).toMatchObject({ status: 'available', count: 1, mean: 8,
    own: { observation: first.observation, revisionHead: first.observationRevision, availability: 'available', value: 8 } });
  // Not a public answer: the read is never cacheable, and the public aggregate stays what it was.
  expect((await mine(h.owner, target, q.context)).headers.get('cache-control')).toBe('private, no-store');
  const publicRead = await h.json<Read>(await h.call(h.owner, 'GET', `/v1/resources/${short(target)}/ratings?scope=realm&realm=${encodeURIComponent(h.realm)}&context=${
    encodeURIComponent(q.context)}&actingSubject=${encodeURIComponent(h.owner.actor)}`));
  expect(publicRead.own).toBeUndefined();
  expect(publicRead).toMatchObject({ count: 1 });

  // Another person's read of the same target and Context holds none of it; an anonymous reader is refused.
  const other = await h.json<Read>(await mine(h.outsider, target, q.context));
  expect(other).toMatchObject({ own: null, count: 0, mean: null });
  expect(JSON.stringify(other)).not.toContain(first.observationRevision);
  expect((await mine(null, target, q.context)).status).toBe(401);

  // A second device holds no head: its write is refused with the current one, and retrying with it succeeds.
  const stale = await rate(h.owner, q.context, target, 5, null);
  expect(stale.status).toBe(409);
  expect(await stale.json()).toMatchObject({ code: 'stale_head', currentHead: first.observationRevision });
  const retried = await h.json<Opinion>(await rate(h.owner, q.context, target, 5, first.observationRevision), 201);
  expect(await h.json(await mine(h.owner, target, q.context))).toMatchObject({ count: 1, mean: 5,
    own: { observation: first.observation, revisionHead: retried.observationRevision, value: 5 } });

  // The refusal names the head current at that moment, not the one a client last saw.
  const again = await rate(h.owner, q.context, target, 6, first.observationRevision);
  expect(again.status).toBe(409);
  expect(await again.json()).toMatchObject({ currentHead: retried.observationRevision });

  // A withdrawal is an observation too: its head is what the next write must name.
  const withdrawn = await h.json<Opinion>(await rate(h.owner, q.context, target, null, retried.observationRevision), 201);
  expect(await h.json(await mine(h.owner, target, q.context))).toMatchObject({ count: 0, mean: null, meanDisplay: 'no-data',
    own: { observation: first.observation, revisionHead: withdrawn.observationRevision, availability: 'withdrawn', value: null } });
  await h.json(await rate(h.owner, q.context, target, 9, withdrawn.observationRevision), 201);
  // Another person's stale write learns only their own head: nothing of the owner's.
  await h.grant(h.outsider, `rating:observe:${q.context}`, 'rating.observation.set');
  const foreign = await rate(h.outsider, q.context, target, 4, first.observationRevision);
  expect(foreign.status).toBe(409);
  expect(await foreign.json()).toMatchObject({ code: 'stale_head', currentHead: null });
}

test('a rater reads their own value and head on a Character, and a stale write returns the head to retry with', async () => {
  await ownIsReadable(await h.semantic('Kirito'), 'resource');
}, 120_000);

test('a rater reads their own value and head on a projection, and a stale write returns the head to retry with', async () => {
  const subject = await h.semantic('Asuna');
  await ownIsReadable((await h.project(subject, [h.work.work])).id, 'projection');
}, 120_000);

test('mine needs a Context of the target grain; without one it states no Context', async () => {
  const subject = await h.semantic('Yui');
  const q = await h.question({ targetGrain: 'projection' });
  expect(await h.json(await h.call(h.owner, 'GET',
    `/v1/resources/${short(subject)}/ratings?scope=mine&actingSubject=${encodeURIComponent(h.owner.actor)}`)))
    .toMatchObject({ status: 'no-context', count: 0 });
  expect((await mine(h.owner, subject, q.context)).status).toBe(422);
}, 60_000);
