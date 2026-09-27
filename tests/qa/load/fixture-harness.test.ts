import { expect, test } from 'bun:test';
import { LOAD_PREPARATION_BUDGET_MS, loadFixtureFiles, loadFixturePlan }
  from '../../../scripts/qa/core.ts';

test('OPS05/SEARCH18/REC02: load fixture preparation gives each selected case an isolated copy', () => {
  const files = Object.values(loadFixtureFiles);
  const all = loadFixturePlan('20260927t030607-5979ff', files);
  expect(all).toEqual([
    { caseId: 'OPS05', runId: 'fixture-20260927t0306075979ff-o' },
    { caseId: 'SEARCH18', runId: 'fixture-20260927t0306075979ff-s' },
    { caseId: 'REC02', runId: 'fixture-20260927t0306075979ff-r' },
  ]);
  expect(new Set(all.map(item => item.runId)).size).toBe(3);
  expect(all.every(item => /^fixture-[a-z0-9-]{1,27}$/.test(item.runId))).toBe(true);
  expect(all.every(item => item.runId.length <= 31)).toBe(true);
  expect(loadFixturePlan('20260927t030607-5979ff', files, 'SEARCH18')).toEqual([all[1]]);
  expect(loadFixturePlan('20260927t030607-5979ff',
    ['tests/qa/load/fixture-restore.test.ts'])).toEqual([all[1]]);
  expect(LOAD_PREPARATION_BUDGET_MS).toBe(600_000);
});
