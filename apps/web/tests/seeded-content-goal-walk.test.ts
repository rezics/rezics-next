import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  firstScopeRows,
  jwtAccountId,
  publicFields,
  summarizeWalk,
  walkWorkingDirectory,
} from '../scripts/seeded-content-goal-walk.ts';

test('the Content Goal walk names every first-scope row and summarises passing, total and slowest failure', () => {
  expect(walkWorkingDirectory()).toBe(resolve(import.meta.dir, '..'));
  expect(firstScopeRows()).toEqual([
    'threads-and-boards',
    'realms-and-spaces',
    'ratings-and-reviews',
    'work-to-review',
    'media',
    'moderation-reports-appeals',
    'notices',
    'home-discovery',
    'persona-matrix',
  ]);
  const summary = summarizeWalk([
    { row: 'threads-and-boards', status: 'passing', durationMs: 1200, observed: { threads: 1 } },
    { row: 'notices', status: 'failing', durationMs: 4800, defect: 'inbox unbound', observed: { status: 404 } },
    { row: 'media', status: 'passing', durationMs: 900, observed: { state: 'reserved' } },
  ]);
  expect(summary).toEqual({
    passing: 2,
    total: 3,
    slowestFailure: { row: 'notices', durationMs: 4800, defect: 'inbox unbound' },
  });
  expect(jwtAccountId('header.eyJzdWIiOiIwMDAwMDAwMC0wMDAwLTQwMDAtODAwMC0wMDAwMDAwMDAwMDEifQ.sig')).toBe(
    '00000000-0000-4000-8000-000000000001',
  );
  expect(publicFields({ token: 'secret', threadId: 'shown' })).toEqual({ threadId: 'shown' });
  const source = readFileSync(resolve(import.meta.dir, '../scripts/seeded-content-goal-walk.ts'), 'utf8');
  expect(source).toContain('retireStaleSeedJournals');
  expect(source).toContain('startSeededFrontends');
  expect(source).toContain('waitUntilWalkReady');
});
