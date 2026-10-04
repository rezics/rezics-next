import { expect, test } from 'bun:test';
import { bars, figuresOfMember, figuresOfRating, scoreView } from '../features/scoped-rating/score.ts';
import * as fixture from '../features/scoped-rating/fixtures.ts';

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
