import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { acquireFullLock, expectedFusekiModuleVersion, parseArgs, writeSummary,
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

test('QA03: command failures produce escaped JUnit output', () => {
  expect(xmlForCommand('static', false, 1000, '<bad>')).toContain('&lt;bad&gt;');
  expect(xmlForCommand('static', false, 1000, 'bad')).toContain('failures="1"');
});

test('QA12: QA bootstrap rejects a Fuseki module that differs from the Compose pin', () => {
  expect(expectedFusekiModuleVersion('services:\n  fuseki:\n    image: rezics/fuseki:6.2.0-cmd0.5.10\n'))
    .toBe('0.5.10');
  expect(() => expectedFusekiModuleVersion('services:\n  fuseki:\n    image: rezics/fuseki:6.2.0-base1\n'))
    .toThrow('must pin one command-module');
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
