import { expect, test } from 'bun:test';
import { bars, figuresOfMember, figuresOfRating, ratingsCounted, scoreView } from '../features/scoped-rating/score.ts';
import * as fixture from '../features/scoped-rating/fixtures.ts';
import * as workFixture from '../features/work-page/fixtures.ts';

const rating = (count: number, mean: number) => fixture.ratingOf(fixture.iri('1'), fixture.writing.context, fixture.histogram(count, mean));

test('no ratings say so and never draw a zero or an empty histogram', () => {
  const figures = figuresOfRating(rating(0, 0))!;
  expect(scoreView(figures)).toEqual({ kind: 'none' });
  expect(bars(figures)).toBeNull();
});

test('below the display threshold the count shows with how many more ratings reveal the average', () => {
  const figures = figuresOfRating(rating(3, 5))!;
  expect(figures.mean).toBeNull();
  expect(scoreView(figures)).toEqual({ kind: 'withheld', count: 3, remaining: fixture.THRESHOLD - 3 });
  // The histogram always shows, so the counts are never hidden with the mean.
  expect(bars(figures)?.reduce((sum, bar) => sum + bar.count, 0)).toBe(3);
});

test('a withheld mean without a threshold says it is withheld without inventing how many are missing', () => {
  expect(scoreView({ count: 4, mean: null, displayThreshold: null, max: 10 })).toEqual({ kind: 'withheld', count: 4, remaining: null });
  // A threshold already met cannot be the reason; no count is made up either.
  expect(scoreView({ count: 12, mean: null, displayThreshold: 10, max: 10 })).toEqual({ kind: 'withheld', count: 12, remaining: null });
});

test('from the threshold the mean shows with its scale and count', () => {
  const figures = figuresOfRating(rating(214, 8.8))!;
  const view = scoreView(figures);
  expect(view).toMatchObject({ kind: 'shown', count: 214, max: 10 });
  expect(view.kind === 'shown' && view.mean).toBeGreaterThan(8);
  expect(bars(figures)?.[0]?.value).toBe(10);
  expect(bars(figures)).toHaveLength(10);
});

test('a mean Main did not publish is never taken from the histogram', () => {
  const read = { ...rating(40, 7), meanDisplay: 'withheld-below-threshold' as const, mean: 7.1 };
  expect(figuresOfRating(read)?.mean).toBeNull();
});

test('a target with no question has no figures', () => {
  expect(figuresOfRating({ ...rating(5, 5), status: 'no-context', scale: null })).toBeNull();
});

test('roll-up members that could not be counted are not figures', () => {
  expect(figuresOfMember({ target: fixture.iri('1'), status: 'not-accepted' }, 10, 10)).toBeNull();
  expect(figuresOfMember({ target: fixture.iri('1'), status: 'unavailable', reason: 'unavailable' }, 10, 10)).toBeNull();
});

test('a Work’s read, which has no display state, follows the same rules as a target’s', () => {
  if (!workFixture.globalRatings.ok || !workFixture.noGlobalRatings.ok) throw new Error('fixture unavailable');
  const rated = figuresOfRating(workFixture.globalRatings.data.summary)!;
  expect(scoreView(rated)).toMatchObject({ kind: 'shown', count: 1287, max: 5 });
  expect(bars(rated)?.map(bar => bar.value)).toEqual([5, 4, 3, 2, 1]);
  const none = figuresOfRating(workFixture.noGlobalRatings.data.summary)!;
  expect(scoreView(none)).toEqual({ kind: 'none' });
  expect(bars(none)).toBeNull();
});

test('under mean-of-means the count is only the members the value was averaged over; pooled counts every readable one', async () => {
  const api = fixture.memoryScopedRatingApi(fixture.populated);
  // Episodes 1, 2, 3 and 5 meet the threshold (190, 41, 214 and 76 ratings); episode 4 has 3 and does not.
  const targets = [fixture.placeEpisode1, fixture.placeEpisode2, fixture.placeEpisode3, fixture.placeEpisode4, fixture.placeEpisode5]
    .map(read => read.projection.id);
  const pooled = await api.rollup(fixture.writing.context, targets, 'pooled');
  const means = await api.rollup(fixture.writing.context, targets, 'mean-of-means');
  if (!pooled.ok || !means.ok) throw new Error('unreadable');
  expect(ratingsCounted(pooled.data)).toBe(190 + 41 + 214 + 3 + 76);
  expect(ratingsCounted(means.data)).toBe(190 + 41 + 214 + 76);
});

test('a member the question does not accept or that cannot be read adds no ratings to either count', async () => {
  const api = fixture.memoryScopedRatingApi({ ...fixture.populated, unreadable: [fixture.placeEpisode2.projection.id] });
  const targets = [fixture.placeEpisode1, fixture.placeEpisode2, fixture.placeNovel].map(read => read.projection.id);
  const answer = await api.rollup(fixture.writing.context, targets, 'pooled');
  if (!answer.ok) throw new Error('unreadable');
  expect(ratingsCounted(answer.data)).toBe(190);
});
