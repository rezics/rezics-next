import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { acceptanceStatuses, caseInventory, type TestResult } from '../../../scripts/qa/acceptance.ts';
import { declaredCaseCoverage, missingCaseDeclarations, renderQualification }
  from '../../../scripts/qa/coverage.ts';

const cases = caseInventory(resolve(import.meta.dir, '../../..'));

test('QA08: IAM06 needs Org/Realm episodes, private dependent proofs and WAL recovery', () => {
  const coverage = declaredCaseCoverage(cases, 'backend');
  const identities = coverage.get('IAM06')!;
  expect(identities).toHaveLength(4);
  const results = identities.map(identity => {
    const [tier, file, ...title] = identity.split(':');
    const name = title.join(':');
    expect(readFileSync(resolve(import.meta.dir, '../../..', file!), 'utf8')).toContain(`test('${name}'`);
    return { tier, file, name, failed: false, skipped: false } as TestResult;
  });
  expect(acceptanceStatuses(cases, results, false, coverage).IAM06.status).toBe('partial-pass');
  for (let n = 0; n < results.length; n++) {
    expect(acceptanceStatuses(cases, results.filter((_, i) => i !== n), true, coverage).IAM06.status)
      .toBe('partial-pass');
  }
  expect(acceptanceStatuses(cases, results, true, coverage).IAM06.status).toBe('passed');
});

test('QA08: RATE02 requires the three-cadence owner case and occasion model evidence in one complete run', () => {
  const coverage = declaredCaseCoverage(cases, 'backend');
  const identities = coverage.get('RATE02')!;
  expect(identities).toHaveLength(3);
  const results = identities.map(identity => {
    const [tier, file, ...title] = identity.split(':');
    const name = title.join(':');
    expect(readFileSync(resolve(import.meta.dir, '../../..', file!), 'utf8')).toContain(`test('${name}'`);
    return { tier, file, name, failed: false, skipped: false } as TestResult;
  });
  expect(acceptanceStatuses(cases, results, false, coverage).RATE02.status).toBe('partial-pass');
  for (let n = 0; n < results.length; n++) {
    expect(acceptanceStatuses(cases, results.filter((_, i) => i !== n), true, coverage).RATE02.status).toBe('partial-pass');
  }
  expect(acceptanceStatuses(cases, results, true, coverage).RATE02.status).toBe('passed');
});

test('QA08: RATE03 requires its exact owner, native model and calendar test identities', () => {
  const coverage = declaredCaseCoverage(cases, 'backend');
  const identities = coverage.get('RATE03')!;
  expect(identities).toHaveLength(4);
  const results = identities.map(identity => {
    const [tier, file, ...title] = identity.split(':');
    const name = title.join(':');
    const source = readFileSync(resolve(import.meta.dir, '../../..', file!), 'utf8');
    expect(source).toContain(`test('${name}'`);
    return { tier, file, name, failed: false, skipped: false } as TestResult;
  });
  expect(acceptanceStatuses(cases, results, false, coverage).RATE03.status).toBe('partial-pass');
  expect(acceptanceStatuses(cases, results.slice(1), true, coverage).RATE03.status).toBe('partial-pass');
  expect(acceptanceStatuses(cases, results, true, coverage).RATE03.status).toBe('passed');
});

test('QA08: IAM23 requires independent admission, local moderation and retained recovery in one full run', () => {
  const coverage = declaredCaseCoverage(cases, 'backend');
  const identities = coverage.get('IAM23')!;
  expect(identities).toHaveLength(3);
  const results = identities.map(identity => {
    const [tier, file, ...title] = identity.split(':');
    const name = title.join(':');
    const source = readFileSync(resolve(import.meta.dir, '../../..', file!), 'utf8');
    expect(source).toContain(`test('${name}'`);
    return { tier, file, name, failed: false, skipped: false } as TestResult;
  });
  expect(acceptanceStatuses(cases, results, false, coverage).IAM23.status).toBe('partial-pass');
  expect(acceptanceStatuses(cases, results.slice(1), true, coverage).IAM23.status).toBe('partial-pass');
  expect(acceptanceStatuses(cases, results, true, coverage).IAM23.status).toBe('passed');
});

test('QA08: IAM01 requires a real two-product Account and Access selection in one full backend run', () => {
  const coverage = declaredCaseCoverage(cases, 'backend');
  const identities = coverage.get('IAM01')!;
  expect(identities).toHaveLength(1);
  const [tier, file, ...title] = identities[0]!.split(':');
  const name = title.join(':');
  expect(readFileSync(resolve(import.meta.dir, '../../..', file!), 'utf8'))
    .toContain(`test('${name}'`);
  const result = { tier, file, name, failed: false, skipped: false } as TestResult;
  expect(acceptanceStatuses(cases, [result], false, coverage).IAM01.status).toBe('partial-pass');
  expect(acceptanceStatuses(cases, [result], true, coverage).IAM01.status).toBe('passed');
  expect(acceptanceStatuses(cases, [{ ...result, skipped: true }], true, coverage).IAM01.status)
    .toBe('uncovered');
});

test('QA08: IAM03 requires the real many-to-many Account and Access owner result', () => {
  const coverage = declaredCaseCoverage(cases, 'backend');
  const identities = coverage.get('IAM03')!;
  expect(identities).toHaveLength(1);
  const [tier, file, ...title] = identities[0]!.split(':');
  const name = title.join(':');
  expect(readFileSync(resolve(import.meta.dir, '../../..', file!), 'utf8'))
    .toContain(`test('${name}'`);
  const result = { tier, file, name, failed: false, skipped: false } as TestResult;
  expect(acceptanceStatuses(cases, [result], false, coverage).IAM03.status).toBe('partial-pass');
  expect(acceptanceStatuses(cases, [result], true, coverage).IAM03.status).toBe('passed');
  expect(acceptanceStatuses(cases, [{ ...result, skipped: true }], true, coverage).IAM03.status)
    .toBe('uncovered');
});

test('QA08: IAM24 requires independent admission, explicit management, atomic move, local moderation and WAL recovery', () => {
  const coverage = declaredCaseCoverage(cases, 'backend');
  const identities = coverage.get('IAM24')!;
  expect(identities).toHaveLength(5);
  const results = identities.map(identity => {
    const [tier, file, ...title] = identity.split(':');
    const name = title.join(':');
    const source = readFileSync(resolve(import.meta.dir, '../../..', file!), 'utf8');
    expect(source).toContain(`test('${name}'`);
    return { tier, file, name, failed: false, skipped: false } as TestResult;
  });
  expect(acceptanceStatuses(cases, results, false, coverage).IAM24.status).toBe('partial-pass');
  for (let n = 0; n < results.length; n++) {
    expect(acceptanceStatuses(cases, results.filter((_, i) => i !== n), true, coverage).IAM24.status)
      .toBe('partial-pass');
  }
  expect(acceptanceStatuses(cases, results, true, coverage).IAM24.status).toBe('passed');
});

test('QA08: IAM26 needs the exact represented roster API and restored authority episode together', () => {
  const coverage = declaredCaseCoverage(cases, 'backend');
  const identities = coverage.get('IAM26')!;
  expect(identities).toHaveLength(2);
  const results = identities.map(identity => {
    const [tier, file, ...title] = identity.split(':');
    const name = title.join(':');
    const source = readFileSync(resolve(import.meta.dir, '../../..', file!), 'utf8');
    expect(source).toContain(`test('${name}'`);
    return { tier, file, name, failed: false, skipped: false } as TestResult;
  });
  expect(acceptanceStatuses(cases, results, false, coverage).IAM26.status).toBe('partial-pass');
  for (let n = 0; n < results.length; n++) {
    expect(acceptanceStatuses(cases, results.filter((_, i) => i !== n), true, coverage).IAM26.status)
      .toBe('partial-pass');
  }
  expect(acceptanceStatuses(cases, results, true, coverage).IAM26.status).toBe('passed');
});

test('QA08: IAM25 needs the exact selected-set API and restored authority episode together', () => {
  const coverage = declaredCaseCoverage(cases, 'backend');
  const identities = coverage.get('IAM25')!;
  expect(identities).toHaveLength(2);
  const results = identities.map(identity => {
    const [tier, file, ...title] = identity.split(':');
    const name = title.join(':');
    const source = readFileSync(resolve(import.meta.dir, '../../..', file!), 'utf8');
    expect(source).toContain(`test('${name}'`);
    return { tier, file, name, failed: false, skipped: false } as TestResult;
  });
  expect(acceptanceStatuses(cases, results, false, coverage).IAM25.status).toBe('partial-pass');
  for (let n = 0; n < results.length; n++) {
    expect(acceptanceStatuses(cases, results.filter((_, i) => i !== n), true, coverage).IAM25.status)
      .toBe('partial-pass');
  }
  expect(acceptanceStatuses(cases, results, true, coverage).IAM25.status).toBe('passed');
});

test('QA08: SEARCH03 needs the real public Content phrase and retained private draft', () => {
  const coverage = declaredCaseCoverage(cases, 'backend');
  const identities = coverage.get('SEARCH03')!;
  expect(identities).toHaveLength(1);
  const [tier, file, ...title] = identities[0]!.split(':');
  const name = title.join(':');
  const source = readFileSync(resolve(import.meta.dir, '../../..', file!), 'utf8');
  expect(source).toContain(`test('${name}'`);
  const result = { tier, file, name, failed: false, skipped: false } as TestResult;
  expect(acceptanceStatuses(cases, [result], false, coverage).SEARCH03.status).toBe('partial-pass');
  expect(acceptanceStatuses(cases, [result], true, coverage).SEARCH03.status).toBe('passed');
  expect(acceptanceStatuses(cases, [{ ...result, failed: true }], true, coverage).SEARCH03.status)
    .toBe('failed');
});

test('QA08: SEARCH02 and SEARCH04 require real relation and bounded candidate evidence', () => {
  const coverage = declaredCaseCoverage(cases, 'backend');
  for (const [id, count] of [['SEARCH02', 3], ['SEARCH04', 2]] as const) {
    const identities = coverage.get(id)!;
    expect(identities).toHaveLength(count);
    const results = identities.map(identity => {
      const [tier, file, ...title] = identity.split(':');
      const name = title.join(':');
      const source = readFileSync(resolve(import.meta.dir, '../../..', file!), 'utf8');
      expect(source).toContain(`test('${name}'`);
      return { tier, file, name, failed: false, skipped: false } as TestResult;
    });
    expect(acceptanceStatuses(cases, results, false, coverage)[id].status).toBe('partial-pass');
    for (let n = 0; n < results.length; n++) {
      expect(acceptanceStatuses(cases, results.filter((_, i) => i !== n), true, coverage)[id].status)
        .toBe('partial-pass');
    }
    expect(acceptanceStatuses(cases, results, true, coverage)[id].status).toBe('passed');
  }
});

test('QA08: WORK02 needs native variants, independent translations and retained recovery together', () => {
  const coverage = declaredCaseCoverage(cases, 'backend');
  const identities = coverage.get('WORK02')!;
  expect(identities).toHaveLength(3);
  const results = identities.map(identity => {
    const [tier, file, ...title] = identity.split(':');
    const name = title.join(':');
    const source = readFileSync(resolve(import.meta.dir, '../../..', file!), 'utf8');
    expect(source).toContain(`test('${name}'`);
    return { tier, file, name, failed: false, skipped: false } as TestResult;
  });
  expect(acceptanceStatuses(cases, results, false, coverage).WORK02.status).toBe('partial-pass');
  for (let n = 0; n < results.length; n++) {
    expect(acceptanceStatuses(cases, results.filter((_, i) => i !== n), true, coverage).WORK02.status)
      .toBe('partial-pass');
  }
  expect(acceptanceStatuses(cases, results, true, coverage).WORK02.status).toBe('passed');
});

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

test('QA08: backend WORK01 needs the API owner result and cannot borrow browser evidence', () => {
  const workCase = [{ id: 'WORK01', page: 'docs/testing/native-work.md' }];
  const native = { tier: 'integration' as const,
    file: 'tests/qa/integration/web-auth-bootstrap.test.ts',
    name: 'IAM01/WORK01: authenticated metadata-only Work has an empty Main Version',
    failed: false, skipped: false };
  const browser = { tier: 'e2e' as const, file: 'apps/web/tests/authenticated-create.e2e.ts',
    name: 'WORK01: authenticated member creates a metadata-only Work with an empty Main Version',
    failed: false, skipped: false };
  const coverage = declaredCaseCoverage(workCase, 'backend');
  expect(coverage.get('WORK01')).toHaveLength(1);
  expect(acceptanceStatuses(workCase, [browser], true, coverage).WORK01.status).toBe('partial-pass');
  expect(acceptanceStatuses(workCase, [native], true, coverage).WORK01.status).toBe('passed');
});

test('QA08: qualification page is generated only from a clean complete case run', () => {
  const report = { runId: 'run-one', source: { head: 'abc', fingerprint: '123', clean: true },
    sourceStable: true, certifiesFull: true,
    ids: { SYS02: { status: 'passed', page: 'docs/testing/backend-integration.md',
      tests: ['fault/recovery:tests/qa/fault-recovery/lost-response.test.ts:SYS02: real fault'] } } };
  const page = renderQualification(report);
  expect(page).toContain('`run-one` passed on clean commit `abc`');
  expect(page).toContain('[SYS02](../testing/backend-integration.md) | pass');
  expect(renderQualification({ ...report, scope: 'backend' })).toContain('yarn qa --backend --record');
  expect(() => renderQualification({ ...report, certifiesFull: false })).toThrow();
  expect(() => renderQualification({ ...report, sourceStable: false })).toThrow();
  expect(() => renderQualification({ ...report, ids: { SYS02: { ...report.ids.SYS02!,
    status: 'partial-pass' } } })).toThrow();
});
