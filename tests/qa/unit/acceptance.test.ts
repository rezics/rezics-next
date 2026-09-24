import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { acceptanceStatuses, caseInventory, e2eArgs, failedSelection, parseJUnit, testArgs, titleIds } from '../../../scripts/qa/acceptance.ts';
import { parseArgs, writeSummary, type Tier } from '../../../scripts/qa/core.ts';

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
    expect(testArgs('unit')).toEqual(['tests/qa/unit', 'scripts/dev/bootstrap.test.ts',
      'scripts/dev/config.test.ts', 'services/main/tests/command.test.ts',
      'services/main/tests/work-command.test.ts', 'services/main/tests/immutable-objects.test.ts',
      'services/main/tests/api-contract.test.ts']);
    expect(testArgs('integration')).toEqual(['tests/qa/integration',
      'infra/jena/tests/command.integration.test.ts',
      'services/main/tests/immutable-objects.integration.test.ts',
      'services/main/tests/content-publication.integration.test.ts',
      'services/main/tests/content-projection.integration.test.ts',
      'services/content/tests/core.integration.test.ts']);
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
    <testcase name="OPS01: pass &amp; go" time="0.125" file="tests/qa/integration/a.test.ts" />
    <testcase name="IAM01: fail" file="tests/qa/integration/b.test.ts"><failure /></testcase>
    <testcase name="MODEL27: skip" file="tests/qa/integration/c.test.ts"><skipped /></testcase>
    </testsuite>`, 'integration');
  expect(results).toHaveLength(3);
  expect(results.map(item => [item.name, item.failed, item.skipped])).toEqual([
    ['OPS01: pass & go', false, false], ['IAM01: fail', true, false],
    ['MODEL27: skip', false, true],
  ]);
  expect(results[0]?.durationMs).toBe(125);
});

test('QA07: Playwright JUnit preserves named test outcomes without inventing acceptance IDs', () => {
  const results = parseJUnit(`<testsuites><testsuite name="public-search.e2e.ts">
    <testcase name="public search reaches Main" classname="public-search.e2e.ts" time="0.25" />
    <testcase name="mobile search filters" classname="public-search.e2e.ts"><failure message="overflow" /></testcase>
    </testsuite></testsuites>`, 'e2e');
  expect(results.map(item => [item.file, item.failed, item.durationMs])).toEqual([
    ['apps/web/tests/public-search.e2e.ts', false, 250],
    ['apps/web/tests/public-search.e2e.ts', true, undefined],
  ]);
  expect(acceptanceStatuses([{ id: 'SEARCH01', page: 'search.md' }], results).SEARCH01.status)
    .toBe('uncovered');
  expect(parseJUnit('<testcase name="fake" classname="../outside.e2e.ts" />', 'e2e'))
    .toEqual([]);
});

test('QA06: failed e2e names and registered files can be reselected', () => {
  const prior = { sourceRunId: 'prior', tiers: ['e2e' as const], tests: [
    { name: 'mobile search filters', file: 'apps/web/tests/public-search.e2e.ts',
      tier: 'e2e' as const, failed: true, skipped: false },
  ] };
  expect(e2eArgs(prior)).toEqual(['apps/web/tests/public-search.e2e.ts',
    '--grep', '(?:^|\\s)(?:mobile search filters)$']);
  expect(e2eArgs(undefined, { files: ['apps/web/tests/public-search.e2e.ts'] }))
    .toEqual(['apps/web/tests/public-search.e2e.ts']);
  expect(() => e2eArgs(undefined, { files: ['apps/web/tests/../bad.e2e.ts'] }))
    .toThrow('not registered');
});

test('QA06: failed fault/recovery test is read from the flat artifact and reselected', () => {
  const artifacts = mkdtempSync(join(scratch, 'rezics-qa-fault-prior-'));
  const prior = join(artifacts, 'fault-one');
  mkdirSync(prior);
  try {
    writeFileSync(join(prior, 'acceptance.json'), JSON.stringify({ tiers: [
      { name: 'fault/recovery', status: 'failed' },
    ] }));
    writeFileSync(join(prior, 'fault-recovery.xml'), `<testsuite>
      <testcase name="SYS02: lost response" file="tests/qa/fault-recovery/lost-response.test.ts"><failure /></testcase>
    </testsuite>`);
    const selection = failedSelection(artifacts, 'fault-one');
    expect(selection.tiers).toEqual(['fault/recovery']);
    expect(testArgs('fault/recovery', selection)).toEqual([
      'tests/qa/fault-recovery/lost-response.test.ts', '-t', '^(?:SYS02: lost response)$',
    ]);
  } finally { rmSync(artifacts, { recursive: true, force: true }); }
});

test('QA08: a complete run requires explicit case coverage before promotion', () => {
  const cases = [{ id: 'OPS01', page: 'operations.md' }, { id: 'IAM01', page: 'identity.md' }];
  const tests = [
    { name: 'OPS01: stack readiness', file: 'tests/qa/integration/a.test.ts',
      tier: 'integration' as const, failed: false, skipped: false, durationMs: 125 },
    { name: 'IAM01: sign in', file: 'tests/qa/e2e/b.test.ts',
      tier: 'e2e' as const, failed: false, skipped: false, durationMs: 80 },
  ];
  expect(acceptanceStatuses(cases, tests).OPS01.status).toBe('partial-pass');
  expect(acceptanceStatuses(cases, tests, true).OPS01.status).toBe('partial-pass');
  const coverage = new Map([
    ['OPS01', ['integration:tests/qa/integration/a.test.ts:OPS01: stack readiness']],
    ['IAM01', ['e2e:tests/qa/e2e/b.test.ts:IAM01: sign in']],
  ]);
  expect(acceptanceStatuses(cases, tests, true, coverage).OPS01.status).toBe('passed');
  expect(acceptanceStatuses(cases, tests, true, new Map([
    ['OPS01', [...coverage.get('OPS01')!, 'fault/recovery:tests/qa/fault/install.test.ts:OPS01: restart']],
  ])).OPS01.status).toBe('partial-pass');
  expect(acceptanceStatuses(cases, [{ ...tests[0]!, skipped: true }, tests[1]!], true, coverage).OPS01.status)
    .toBe('uncovered');
  const dir = mkdtempSync(join(scratch, 'rezics-qa-complete-'));
  try {
    const source = { head: 'abc', fingerprint: 'stable', clean: true };
    const tiers = (['static', 'unit', 'integration', 'model', 'fault/recovery', 'e2e', 'load'] as Tier[])
      .map(name => ({ name, status: 'passed' as const }));
    writeSummary(dir, { runId: 'complete', sourceBefore: source, sourceAfter: source,
      partial: false, errors: [], cases, tests, tiers });
    expect(JSON.parse(readFileSync(join(dir, 'acceptance.json'), 'utf8')).certifiesFull).toBe(false);
    writeSummary(dir, { runId: 'complete', sourceBefore: source, sourceAfter: source,
      partial: false, errors: [], cases, tests, tiers, caseCoverage: coverage });
    const record = JSON.parse(readFileSync(join(dir, 'acceptance.json'), 'utf8'));
    expect(record.certifiesFull).toBe(true);
    expect(record.counts).toEqual({ uncovered: 0, 'partial-pass': 0, passed: 2, failed: 0 });
    expect(record.runKind).toBe('full');
    expect(record.declaredCaseCoverage.OPS01).toEqual(coverage.get('OPS01'));
    expect(record.host).toBeTruthy();
    expect(record.tests[0].durationMs).toBe(125);
    writeSummary(dir, { runId: 'incomplete', sourceBefore: source, sourceAfter: source,
      partial: false, errors: [], cases, tests, tiers: tiers.slice(1) });
    expect(JSON.parse(readFileSync(join(dir, 'acceptance.json'), 'utf8')).certifiesFull).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
