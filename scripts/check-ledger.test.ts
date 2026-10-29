import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ledgerPath, summarize, writeLedger, type CheckLedgerEntry } from './check-ledger.ts';

describe('ledger', () => {
  test('writes running and finished entries atomically under the UTC day', () => {
    const root = mkdtempSync(join(tmpdir(), 'check-ledger-'));
    try {
      const entry: CheckLedgerEntry = { runId: 'physical-1', argv: ['bun', 'test'], start: '2026-10-29T12:00:00.000Z', terminalStatus: 'running' };
      writeLedger(entry, root);
      expect(JSON.parse(readFileSync(ledgerPath(entry, root), 'utf8')).terminalStatus).toBe('running');
      entry.end = '2026-10-29T12:00:10.000Z'; entry.terminalStatus = 'passed'; writeLedger(entry, root);
      expect(JSON.parse(readFileSync(ledgerPath(entry, root), 'utf8')).terminalStatus).toBe('passed');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('clips running entries to the window and totals memory integral', () => {
    const entry: CheckLedgerEntry = { runId: 'r', argv: ['bun', 'test', 'scripts/a.test.ts'], start: '2026-10-29T00:00:00Z', terminalStatus: 'running', memoryGiBSeconds: 7200, samplingIntervalSeconds: 5, sampleCount: 10 };
    const result = summarize([entry], new Date('2026-10-29T00:00:05Z'), new Date('2026-10-29T00:00:10Z')) as any;
    expect(result.byCommandClass['script and control-plane tests'].checkHours).toBeCloseTo(5 / 3600);
    expect(result.byCommandClass['script and control-plane tests'].memoryGiBHours).toBeCloseTo(1 / 3600);
    expect(result.limits.samplingIntervalSeconds).toBe(5);
  });
});
