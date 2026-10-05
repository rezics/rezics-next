import { expect, test } from 'bun:test';
import { homeFeedTargets, type FeedItem } from './home-feed-targets.ts';

const work = (suffix: string) => `https://rezics.com/id/00000000-0000-4000-a000-${suffix.padStart(12, '0')}`;
const item = (id: string, kind: string, target: string | null, count?: number): FeedItem => ({
  id, kind, target: { work: target }, ...(count === undefined ? {} : { group: { count } }) });
const plan = new Set([work('1'), work('2')]);

test('only activity of the plan\'s own Works, written before Home, is a target', () => {
  const items = [item('a', 'work', work('1')), item('b', 'contribution', work('2')), item('c', 'work', work('9')),
    item('d', 'decision', work('1')), item('e', 'adoption', work('2')), item('f', 'contribution', null)];
  expect(homeFeedTargets(items, plan).map(found => found.id)).toEqual(['a', 'b']);
});

test('a grouped activity cannot be voted on from the list, a single one can', () => {
  const items = [item('a', 'work', work('1'), 1), item('b', 'contribution', work('1'), 2), item('c', 'contribution', work('2'))];
  expect(homeFeedTargets(items, plan).map(found => found.id)).toEqual(['a', 'c']);
});

test('newer activity of other kinds or Works does not change the targets', () => {
  const before = [item('a', 'work', work('1')), item('b', 'contribution', work('2'))];
  const after = [item('z', 'decision', work('1')), item('y', 'work', work('9')), ...before];
  expect(homeFeedTargets(after, plan)).toEqual(homeFeedTargets(before, plan));
});
