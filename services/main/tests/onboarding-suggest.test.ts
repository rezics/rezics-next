import { expect, test } from 'bun:test';
import { rankSuggestedFollows } from '../src/modules/onboarding-interests/read.ts';

test('G-329: a matching official Zone survives the response cap ahead of older popular Realms', () => {
  expect(rankSuggestedFollows([
    { value: 'popular-a', matchingOfficial: false, score: 80, index: 0 },
    { value: 'popular-b', matchingOfficial: false, score: 70, index: 1 },
    { value: 'popular-c', matchingOfficial: false, score: 60, index: 2 },
    { value: 'fiction', matchingOfficial: true, score: 1_010, index: 8 },
  ], 3)).toEqual(['fiction', 'popular-a', 'popular-b']);
});

test('G-329: adopted Work and recent activity scores break ties consistently', () => {
  expect(rankSuggestedFollows([
    { value: 'one-work', matchingOfficial: false, score: 11, index: 0 },
    { value: 'three-works', matchingOfficial: false, score: 31, index: 1 },
    { value: 'same-activity-first', matchingOfficial: false, score: 20, index: 2 },
    { value: 'same-activity-later', matchingOfficial: false, score: 20, index: 3 },
  ], 4)).toEqual(['three-works', 'same-activity-first', 'same-activity-later', 'one-work']);
});
