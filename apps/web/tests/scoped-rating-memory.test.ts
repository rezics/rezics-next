import { expect, test } from 'bun:test';
import * as fixture from '../features/scoped-rating/fixtures.ts';

// The stories' adapter answers as Main's README says; these keep it from drifting into a rule Main does not have.
const q = fixture.writing.context;
const episode = (read: { projection: { id: string } }) => read.projection.id;

test('pooling and averaging the same episodes give different values, and both travel with their coverage', async () => {
  const api = fixture.memoryScopedRatingApi(fixture.populated);
  const targets = [fixture.placeEpisode1, fixture.placeEpisode2, fixture.placeEpisode3, fixture.placeEpisode5].map(episode);
  const pooled = await api.rollup(q, targets, 'pooled');
  const means = await api.rollup(q, targets, 'mean-of-means');
  if (!pooled.ok || !means.ok) throw new Error('unreadable');
  expect(pooled.data.value).not.toBeNull();
  expect(means.data.value).not.toBeNull();
  expect(pooled.data.value).not.toBeCloseTo(means.data.value!, 2);
  expect(pooled.data.coverage).toEqual({ members: 4, available: 4, meetingThreshold: 4 });
});

test('a member the question does not accept is named and left out of the value, the coverage and the ranking', async () => {
  const api = fixture.memoryScopedRatingApi(fixture.populated);
  const answer = await api.rollup(q, [fixture.placeEpisode1, fixture.placeEpisode3, fixture.placeNovel].map(episode), 'pooled', true);
  if (!answer.ok) throw new Error('unreadable');
  expect(answer.data.members.find(member => member.target === fixture.placeNovel.projection.id)?.status).toBe('not-accepted');
  expect(answer.data.coverage.members).toBe(2);
  expect(answer.data.rank?.items.map(item => item.target)).not.toContain(fixture.placeNovel.projection.id);
});

test('the value is withheld where fewer than half of the members have enough ratings', async () => {
  const api = fixture.memoryScopedRatingApi(fixture.belowThreshold);
  const answer = await api.rollup(q, [fixture.placeEpisode4, fixture.placeEpisode2, fixture.placeEpisode1].map(episode), 'pooled');
  if (!answer.ok) throw new Error('unreadable');
  expect(answer.data).toMatchObject({ value: null, valueWithheld: 'coverage-below-half', coverage: { members: 3, meetingThreshold: 0 } });
});

test('a ranking waits for 50 ratings and orders by the weighted rating, not the raw mean', async () => {
  const api = fixture.memoryScopedRatingApi(fixture.participantScenario);
  const answer = await api.rollup(fixture.performance.context, [fixture.kestrel, fixture.vesper, fixture.orin, fixture.mako].map(episode), 'pooled', true);
  if (!answer.ok) throw new Error('unreadable');
  const { rank } = answer.data;
  expect(rank).toMatchObject({ status: 'ranked', minimumRatings: 50 });
  expect(rank?.items.map(item => item.target)).toEqual([fixture.kestrel, fixture.vesper].map(episode));
  // Orin's raw mean is the highest, but 12 ratings do not earn a place.
  expect(rank?.items.every(item => item.count >= 50)).toBe(true);
  const thin = await fixture.memoryScopedRatingApi(fixture.thinParticipants)
    .rollup(fixture.performance.context, [fixture.kestrel, fixture.vesper].map(episode), 'pooled', true);
  expect(thin.ok && thin.data.rank?.status).toBe('unavailable');
});

test('rating replaces the person’s earlier rating, moving one count and never adding two', async () => {
  const api = fixture.memoryScopedRatingApi({ ...fixture.populated, histograms: {} });
  const target = episode(fixture.placeEpisode1);
  await api.rate(target, q, 6);
  await api.rate(target, q, 9);
  const read = await api.rating(target, q, { kind: 'global' });
  expect(read.ok && read.data.count).toBe(1);
  expect(await api.own(target, q)).toEqual({ ok: true, data: { value: 9 } });
  await api.rate(target, q, null);
  const after = await api.rating(target, q, { kind: 'global' });
  expect(after.ok && after.data.count).toBe(0);
});
