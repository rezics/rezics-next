import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { acceptanceStatuses, caseInventory, failedSelection, parseJUnit, testArgs, titleIds } from '../../../scripts/qa/acceptance.ts';
import { parseArgs, writeSummary } from '../../../scripts/qa/core.ts';

const root = resolve(import.meta.dir, '../../..');
const scratch = join(root, '.temp');
mkdirSync(scratch, { recursive: true });

test('QA04: every retained case table row is inventoried with its owning page', () => {
  const cases = caseInventory(root);
  expect(cases.length).toBeGreaterThan(250);
  expect(new Set(cases.map(item => item.id)).size).toBe(cases.length);
  expect(cases.find(item => item.id === 'OPS01')?.page).toBe('docs/testing/operations.md');
  expect(cases.find(item => item.id === 'IAM01')?.page).toBe('docs/testing/identity-and-access.md');
  expect(cases.find(item => item.id === 'MODEL27')?.page).toBe('docs/testing/model-contracts.md');
});

test('QA05: only executed named tests contribute partial or failed ID status', () => {
  const cases = [{ id: 'OPS01', page: 'a.md' }, { id: 'IAM01', page: 'b.md' },
    { id: 'MODEL27', page: 'c.md' }];
  expect(titleIds('OPS01/IAM01: smoke')).toEqual(['OPS01', 'IAM01']);
  const passed = { name: 'OPS01/IAM01: smoke', file: 'tests/qa/integration/smoke.test.ts',
    tier: 'integration' as const, failed: false, skipped: false };
  const statuses = acceptanceStatuses(cases, [passed]);
  expect(statuses.OPS01.status).toBe('partial-pass');
  expect(statuses.IAM01.status).toBe('partial-pass');
  expect(statuses.MODEL27.status).toBe('uncovered');
  expect(acceptanceStatuses(cases, [{ ...passed, failed: true }]).OPS01.status).toBe('failed');
  expect(acceptanceStatuses(cases, [{ ...passed, skipped: true }]).OPS01.status).toBe('uncovered');
});

test('QA06: failure rerun selects failed names without borrowing prior passes', () => {
  const artifacts = mkdtempSync(join(scratch, 'rezics-qa-prior-'));
  const prior = join(artifacts, 'run-one');
  mkdirSync(prior);
  try {
    writeFileSync(join(prior, 'acceptance.json'), JSON.stringify({ tiers: [
      { name: 'static', status: 'passed' }, { name: 'unit', status: 'failed' },
      { name: 'integration', status: 'passed' },
    ] }));
    writeFileSync(join(prior, 'unit.xml'), `<testsuites><testsuite>
      <testcase name="QA01: prior pass" file="tests/qa/unit/core.test.ts" />
      <testcase name="QA02: failed (a+b)" file="tests/qa/unit/core.test.ts"><failure message="bad" /></testcase>
      </testsuite></testsuites>`);
    const selection = failedSelection(artifacts, 'run-one');
    expect(selection.tiers).toEqual(['unit']);
    expect(selection.tests.map(item => item.name)).toEqual(['QA02: failed (a+b)']);
    expect(testArgs('unit', selection)).toEqual(['tests/qa/unit/core.test.ts', '-t',
      '^(?:QA02: failed \\(a\\+b\\))$']);
    expect(parseArgs(['--only-failed', 'run-one']).onlyFailed).toBe('run-one');
    expect(() => parseArgs(['--only-failed', '../bad'])).toThrow();
    const current = join(artifacts, 'current');
    const source = { head: 'abc', fingerprint: 'new', clean: false };
    writeSummary(current, { runId: 'current', sourceBefore: source, sourceAfter: source,
      partial: true, diagnosticOf: 'run-one', errors: [],
      cases: [{ id: 'OPS01', page: 'docs/testing/operations.md' }],
      tests: [], tiers: [{ name: 'unit', status: 'passed' }] });
    const record = JSON.parse(readFileSync(join(current, 'acceptance.json'), 'utf8'));
    expect(record.ids.OPS01.status).toBe('uncovered');
    expect(record.certifiesFull).toBe(false);
    expect(record.diagnosticOf).toBe('run-one');
  } finally { rmSync(artifacts, { recursive: true, force: true }); }
});

test('QA07: JUnit parser distinguishes failures and skipped tests', () => {
  const results = parseJUnit(`<testsuite>
    <testcase name="OPS01: pass &amp; go" file="tests/qa/integration/a.test.ts" />
    <testcase name="IAM01: fail" file="tests/qa/integration/b.test.ts"><failure /></testcase>
    <testcase name="MODEL27: skip" file="tests/qa/integration/c.test.ts"><skipped /></testcase>
    </testsuite>`, 'integration');
  expect(results).toHaveLength(3);
  expect(results.map(item => [item.name, item.failed, item.skipped])).toEqual([
    ['OPS01: pass & go', false, false], ['IAM01: fail', true, false],
    ['MODEL27: skip', false, true],
  ]);
});
