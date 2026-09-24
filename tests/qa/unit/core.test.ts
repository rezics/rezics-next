import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { acquireFullLock, parseArgs, writeSummary, xmlForCommand } from '../../../scripts/qa/core.ts';

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
  expect(parseArgs(['--tier', 'integration'])).toEqual({ tier: 'integration', keep: false, record: false });
  expect(() => parseArgs(['--record', '--tier', 'unit'])).toThrow();
  const dir = mkdtempSync(join(scratch, 'rezics-qa-summary-'));
  const source = { head: 'abc', fingerprint: 'fingerprint', clean: true };
  try {
    writeSummary(dir, { runId: 'test', sourceBefore: source, sourceAfter: source,
      partial: true, errors: [], tiers: [
        { name: 'integration', status: 'passed' }, { name: 'model', status: 'uncovered' },
      ] });
    const acceptance = JSON.parse(readFileSync(join(dir, 'acceptance.json'), 'utf8'));
    expect(acceptance.certifiesFull).toBe(false);
    expect(acceptance.partial).toBe(true);
    expect(acceptance.tiers[1].status).toBe('uncovered');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('QA03: command failures produce escaped JUnit output', () => {
  expect(xmlForCommand('static', false, 1000, '<bad>')).toContain('&lt;bad&gt;');
  expect(xmlForCommand('static', false, 1000, 'bad')).toContain('failures="1"');
});
