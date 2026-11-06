import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { installedRatingsPage, walkWorkingDirectory } from '../scripts/seeded-content-ratings-reviews-walk.ts';

test('the ratings walk runs from apps/web with installed Subject page types and no root lease preload', () => {
  expect(walkWorkingDirectory()).toBe(resolve(import.meta.dir, '..'));
  expect(installedRatingsPage()).toEqual({
    questionId: '00000000-0000-7000-8000-000000000001',
    population: '00000000-0000-8000-8000-000000000000',
  });
  const source = readFileSync(resolve(import.meta.dir, '../scripts/seeded-content-ratings-reviews-walk.ts'), 'utf8');
  expect(source).toContain("await import('../src/features/pages/subject-ratings.ts')");
  expect(source).toContain('assert.equal(pageTypes.questionId, QUESTION)');
  expect(source).toContain('cwd: webRoot');
  expect(readFileSync(resolve(import.meta.dir, '../bunfig.toml'), 'utf8')).not.toContain('stack-lease-preload');
  expect(readFileSync(resolve(import.meta.dir, '../../../bunfig.toml'), 'utf8')).toContain('stack-lease-preload');
});
