import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { acquireFullLock, expectedFusekiModuleVersion, parseArgs, testLogEnvironment, writeSummary,
  implementedTiers, tierArtifactName, xmlForCommand } from '../../../scripts/qa/core.ts';

const scratch = join(import.meta.dir, '../../../.temp');
mkdirSync(scratch, { recursive: true });

test('QA01: overlapping full runs are rejected and lock releases', () => {
  const root = mkdtempSync(join(scratch, 'rezics-qa-lock-'));
  try {
    const release = acquireFullLock(root, 'first');
    expect(() => acquireFullLock(root, 'second')).toThrow('Another full QA run');
    release();
    acquireFullLock(root, 'third')();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('QA02: selected tier and uncovered tiers cannot certify full', () => {
  expect(parseArgs(['--tier', 'integration'])).toEqual({ tier: 'integration', onlyFailed: undefined, keep: false, record: false });
  expect(() => parseArgs(['--record', '--tier', 'unit'])).toThrow();
  const dir = mkdtempSync(join(scratch, 'rezics-qa-summary-'));
  const source = { head: 'abc', fingerprint: 'fingerprint', clean: true };
  try {
    writeSummary(dir, { runId: 'test', sourceBefore: source, sourceAfter: source,
      partial: true, errors: [], cases: [{ id: 'OPS01', page: 'docs/testing/operations.md' }], tests: [], tiers: [
        { name: 'integration', status: 'passed' }, { name: 'model', status: 'uncovered' },
      ] });
    const acceptance = JSON.parse(readFileSync(join(dir, 'acceptance.json'), 'utf8'));
    expect(acceptance.certifiesFull).toBe(false);
    expect(acceptance.partial).toBe(true);
    expect(acceptance.tiers[1].status).toBe('uncovered');
    expect(acceptance.ids.OPS01.status).toBe('uncovered');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('QA02: backend mode selects non-browser tiers and records its exact scope', () => {
  expect(parseArgs(['--backend', '--record']).backend).toBe(true);
  expect(() => parseArgs(['--backend', '--tier', 'e2e'])).toThrow('no e2e');
  expect(() => parseArgs(['--backend', '--only-failed', 'run-one'])).toThrow('unsupported');
  const dir = mkdtempSync(join(scratch, 'rezics-qa-backend-'));
  const source = { head: 'abc', fingerprint: 'fingerprint', clean: true };
  const testResult = { tier: 'integration' as const, file: 'tests/qa/integration/case.test.ts',
    name: 'OPS01: exact backend case', failed: false, skipped: false };
  const tiers = ['static', 'unit', 'integration', 'model', 'fault/recovery', 'load']
    .map(name => ({ name: name as Tier, status: 'passed' as const }));
  try {
    const report = { runId: 'backend', sourceBefore: source, sourceAfter: source,
      partial: false, errors: [], cases: [{ id: 'OPS01', page: 'docs/testing/operations.md' }],
      tests: [testResult], tiers, caseCoverage: new Map([['OPS01',
        ['integration:tests/qa/integration/case.test.ts:OPS01: exact backend case']]]),
      excludedCases: [{ id: 'VIEW04', page: 'docs/testing/presentation-and-addressing.md',
        reason: 'rendering only' }], inventoryFingerprint: 'frozen' };
    writeSummary(dir, { ...report, scope: 'backend' });
    const backend = JSON.parse(readFileSync(join(dir, 'acceptance.json'), 'utf8'));
    expect(backend.certifiesFull).toBe(true);
    expect(backend.scope).toBe('backend');
    expect(backend.excludedCases[0].id).toBe('VIEW04');
    expect(backend.inventoryFingerprint).toBe('frozen');
    const dirtySource = { ...source, clean: false };
    writeSummary(dir, { ...report, sourceBefore: dirtySource, sourceAfter: dirtySource, scope: 'backend' });
    expect(JSON.parse(readFileSync(join(dir, 'acceptance.json'), 'utf8')).certifiesFull).toBe(false);
    writeSummary(dir, { ...report, scope: 'all' });
    expect(JSON.parse(readFileSync(join(dir, 'acceptance.json'), 'utf8')).certifiesFull).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('QA03: command failures produce escaped JUnit output', () => {
  expect(xmlForCommand('static', false, 1000, '<bad>')).toContain('&lt;bad&gt;');
  expect(xmlForCommand('static', false, 1000, 'bad')).toContain('failures="1"');
});

test('QA12: QA bootstrap rejects a Fuseki module that differs from the Compose pin', () => {
  expect(expectedFusekiModuleVersion('services:\n  fuseki:\n    image: rezics/fuseki:6.2.0-cmd0.5.12\n'))
    .toBe('0.5.12');
  expect(() => expectedFusekiModuleVersion('services:\n  fuseki:\n    image: rezics/fuseki:6.2.0-base1\n'))
    .toThrow('must pin one command-module');
  expect(expectedFusekiModuleVersion('services:\n  fuseki:\n    image: rezics/fuseki:6.2.0-cmd0.5.29-4dc9015683cb\n'))
    .toBe('0.5.29');
});

test('QA tier Bun runs drop agent output variables so logs list every test', () => {
  expect(testLogEnvironment({ PATH: '/bin', AGENT: '1', CLAUDECODE: '1', REPL_ID: 'x', FUSEKI_URL: 'u' }))
    .toEqual({ PATH: '/bin', FUSEKI_URL: 'u' });
});

test('QA02: fault/recovery is a selectable implemented tier with one artifact basename', () => {
  expect(implementedTiers).toContain('fault/recovery');
  expect(parseArgs(['--tier', 'fault/recovery', '--id', 'SYS02']).tier).toBe('fault/recovery');
  expect(tierArtifactName('fault/recovery')).toBe('fault-recovery');
});

test('QA02: load is an implemented isolated tier', () => {
  expect(implementedTiers).toContain('load');
  expect(parseArgs(['--tier', 'load', '--id', 'OPS05']).tier).toBe('load');
  expect(tierArtifactName('load')).toBe('load');
});

test('QA02: e2e is an implemented tier without declaring acceptance coverage', () => {
  expect(implementedTiers).toContain('e2e');
  expect(parseArgs(['--tier', 'e2e'])).toEqual({ tier: 'e2e', onlyFailed: undefined,
    keep: false, record: false });
  expect(parseArgs(['--tier', 'e2e', '--file', 'apps/web/tests/public-search.e2e.ts']).files)
    .toEqual(['apps/web/tests/public-search.e2e.ts']);
});
