import { expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { acceptanceStatuses, caseInventory, type TestResult } from '../../../scripts/qa/acceptance.ts';
import { declaredCaseCoverage, missingCaseDeclarations, renderQualification }
  from '../../../scripts/qa/coverage.ts';

const cases = caseInventory(resolve(import.meta.dir, '../../..'));

test('SYS02: declared lost-response coverage needs the real fault result in one complete run', () => {
  const coverage = declaredCaseCoverage(cases);
  expect(missingCaseDeclarations(cases, coverage)).toContain('SYS03');
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

test('QA08: WORK01 needs both native and browser evidence in one complete run', () => {
  const workCase = [{ id: 'WORK01', page: 'docs/testing/native-work.md' }];
  const native = { tier: 'integration' as const,
    file: 'tests/qa/integration/web-auth-bootstrap.test.ts',
    name: 'IAM01/WORK01: authenticated metadata-only Work has an empty Main Version',
    failed: false, skipped: false };
  const browser = { tier: 'e2e' as const, file: 'apps/web/tests/authenticated-create.e2e.ts',
    name: 'WORK01: authenticated member creates a metadata-only Work with an empty Main Version',
    failed: false, skipped: false };
  const required = declaredCaseCoverage(cases);
  expect(acceptanceStatuses(workCase, [native, browser], false, required).WORK01.status)
    .toBe('partial-pass');
  expect(acceptanceStatuses(workCase, [native], true, required).WORK01.status)
    .toBe('partial-pass');
  expect(acceptanceStatuses(workCase, [native, browser], true, required).WORK01.status)
    .toBe('passed');
  expect(acceptanceStatuses(workCase, [native, { ...browser, failed: true }], true, required).WORK01.status)
    .toBe('failed');
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
