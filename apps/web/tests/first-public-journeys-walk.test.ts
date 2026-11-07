import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { FIRST_PUBLIC_JOURNEY_PATHS } from '../scripts/first-public-journeys-paths.ts';

test('the first-public journey walk names each of the 17 Goal paths once', () => {
  expect(FIRST_PUBLIC_JOURNEY_PATHS).toHaveLength(17);
  expect(FIRST_PUBLIC_JOURNEY_PATHS.map((path) => path.id)).toEqual(
    Array.from({ length: 17 }, (_, index) => `P${String(index + 1).padStart(2, '0')}`),
  );
  expect(new Set(FIRST_PUBLIC_JOURNEY_PATHS.map((path) => path.job)).size).toBe(17);
});

test('the walk retains Settings, Inbox and Library owners and does not import Auth contract', () => {
  const source = readFileSync(resolve(import.meta.dir, '../scripts/first-public-journeys-walk.ts'), 'utf8');
  expect(source).toContain("from './first-public-journeys-paths.ts'");
  expect(source).not.toMatch(/from ['"]@rezics\/auth-contract['"]/);
  expect(new Set(FIRST_PUBLIC_JOURNEY_PATHS.map((path) => path.owner))).toEqual(
    new Set(['Settings', 'Accounts', 'Inbox', 'Library']),
  );
});
