import { expect, test } from 'bun:test';
import { MAX_BRIEF_BYTES, parseBrief } from './briefs.ts';
import { markdown } from './test-support.ts';

test('a brief over the size limit is refused with the reason, since the prompt is one launch argument', () => {
  expect(() => parseBrief(markdown, { version: 1, areas: {} })).not.toThrow();
  const big = `${markdown}\n${'x'.repeat(MAX_BRIEF_BYTES)}\n`;
  expect(() => parseBrief(big, { version: 1, areas: {} })).toThrow('link evidence files instead of pasting them');
});
