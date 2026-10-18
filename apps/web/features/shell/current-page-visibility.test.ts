import { expect, test } from 'bun:test';
import { horizontalRevealDelta } from './current-page-visibility.ts';

test('a directly opened offscreen destination is fully revealed with room for its selected marker', () => {
  const viewport = { left: 16, right: 374 };
  expect(horizontalRevealDelta(viewport, { left: 478, right: 551 })).toBe(181);
  expect(horizontalRevealDelta(viewport, { left: 412, right: 474 })).toBe(104);
  expect(horizontalRevealDelta(viewport, { left: 332, right: 410 })).toBe(40);
});

test('returning to an earlier destination scrolls left; a visible destination leaves the row still', () => {
  expect(horizontalRevealDelta({ left: 16, right: 374 }, { left: -80, right: -10 })).toBe(-100);
  expect(horizontalRevealDelta({ left: 16, right: 1424 }, { left: 478, right: 551 })).toBe(0);
  expect(horizontalRevealDelta({ left: 16, right: 374 }, { left: 20, right: 370 })).toBe(0);
  expect(horizontalRevealDelta({ left: -374, right: -16 }, { left: -551, right: -478 })).toBe(-181);
});
