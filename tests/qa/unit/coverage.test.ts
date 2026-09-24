import { expect, test } from 'bun:test';
import { acceptanceStatuses, type Case, type TestResult } from '../../../scripts/qa/acceptance.ts';
import { declaredCaseCoverage, missingCaseDeclarations, renderQualification }
  from '../../../scripts/qa/coverage.ts';

const cases: Case[] = [
  { id: 'SYS02', page: 'docs/testing/backend-integration.md' },
  { id: 'SYS03', page: 'docs/testing/backend-integration.md' },
];

test('SYS02: declared lost-response coverage needs the real fault result in one complete run', () => {
  const coverage = declaredCaseCoverage(cases);
  expect(missingCaseDeclarations(cases, coverage)).toEqual(['SYS03']);
  const result: TestResult = {
    tier: 'fault/recovery', file: 'tests/qa/fault-recovery/lost-response.test.ts',
    name: 'SYS02: a real lost Fuseki response resolves to one Main Work receipt and outbox batch',
    failed: false, skipped: false,
  };
  expect(acceptanceStatuses(cases, [result], false, coverage).SYS02.status).toBe('partial-pass');
  expect(acceptanceStatuses(cases, [result], true, coverage).SYS02.status).toBe('passed');
  expect(acceptanceStatuses(cases, [{ ...result, skipped: true }], true, coverage).SYS02.status).toBe('uncovered');
  expect(acceptanceStatuses(cases, [{ ...result, failed: true }], true, coverage).SYS02.status).toBe('failed');
});

test('QA08: qualification page is generated only from a clean complete case run', () => {
  const report = { runId: 'run-one', source: { head: 'abc', fingerprint: '123', clean: true },
    sourceStable: true, certifiesFull: true,
    ids: { SYS02: { status: 'passed', page: 'docs/testing/backend-integration.md',
      tests: ['fault/recovery:tests/qa/fault-recovery/lost-response.test.ts:SYS02: real fault'] } } };
  const page = renderQualification(report);
  expect(page).toContain('`run-one` passed on clean commit `abc`');
  expect(page).toContain('[SYS02](../testing/backend-integration.md) | pass');
  expect(() => renderQualification({ ...report, certifiesFull: false })).toThrow();
  expect(() => renderQualification({ ...report, sourceStable: false })).toThrow();
  expect(() => renderQualification({ ...report, ids: { SYS02: { ...report.ids.SYS02!,
    status: 'partial-pass' } } })).toThrow();
});
