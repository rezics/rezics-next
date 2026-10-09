import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

// composeMain builds the worker graph. It is checked as source so the test does
// not start that graph. Integration tests build their own dependencies and cannot
// see a worker the composition includes without an owner it needs.
const root = readFileSync(new URL('../src/composition.ts', import.meta.url), 'utf8');

/** The dependency object literal passed as a constructor's first argument. */
function dependencies(constructor: string): string {
  const start = root.indexOf(`new ${constructor}({`);
  expect(start).toBeGreaterThan(-1);
  let depth = 0;
  for (let index = root.indexOf('{', start); index < root.length; index++) {
    if (root[index] === '{') depth++;
    if (root[index] === '}' && --depth === 0) return root.slice(start, index + 1);
  }
  throw new Error(`${constructor} dependencies are unterminated`);
}

test('G385: Home’s refresh worker has the review owner, so review events reach the feed projection', () => {
  expect(dependencies('FeedRefreshWorker')).toMatch(/\breviews:\s*new ReaderReviews\(/);
});
