import { expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { acceptanceStatuses, caseInventory, type TestResult } from '../../../scripts/qa/acceptance.ts';
import { declaredCaseCoverage } from '../../../scripts/qa/coverage.ts';

test('QA08: RATE01 cannot qualify from reducers or a selected owner run alone', () => {
  const cases = caseInventory(resolve(import.meta.dir, '../../..'));
  const coverage = declaredCaseCoverage(cases, 'backend');
  const required = coverage.get('RATE01')!;
  expect(required).toHaveLength(4);
  const results: TestResult[] = required.map(identity => {
    const [tier, file, ...name] = identity.split(':');
    return { tier: tier as TestResult['tier'], file: file!, name: name.join(':'), failed: false, skipped: false };
  });
  expect(results.some(result => result.tier === 'fault/recovery')).toBe(true);
  expect(acceptanceStatuses(cases, results, false, coverage).RATE01.status).toBe('partial-pass');
  for (let omitted = 0; omitted < results.length; omitted++) {
    expect(acceptanceStatuses(cases, results.filter((_, index) => index !== omitted), true, coverage).RATE01.status).toBe('partial-pass');
  }
  expect(acceptanceStatuses(cases, results, true, coverage).RATE01.status).toBe('passed');
});
