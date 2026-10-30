import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  CHECK_LEDGER_DIRECTORY_ENV,
  checkLedgerDirectory,
  ledgerPath,
  mainCheckout,
  summarize,
  writeLedger,
  type CheckLedgerEntry,
} from './check-ledger.ts';

const repository = resolve(import.meta.dir, '..');

test(
  "ledger isolation: running the worker-check and remote-check test suites adds no file under the main checkout's .temp/check-ledger",
  () => {
    const realLedger = join(mainCheckout(repository), '.temp', 'check-ledger');
    const before = new Set(filesUnder(realLedger));
    const env = { ...process.env };
    // Each suite must establish its own isolation, even without a caller's override.
    delete env[CHECK_LEDGER_DIRECTORY_ENV];
    for (const suite of ['scripts/worker-check.test.ts', 'scripts/remote-check.test.ts']) {
      const result = spawnSync(process.execPath, ['test', suite], {
        cwd: repository,
        encoding: 'utf8',
        timeout: 10 * 60_000,
        env,
      });
      expect(
        filesUnder(realLedger).filter((file) => !before.has(file)),
        suite,
      ).toEqual([]);
      expect(result.error?.message, `${suite}\n${result.stderr}`).toBeUndefined();
      expect(result.status, `${suite}\n${result.stdout}\n${result.stderr}`).toBe(0);
    }
  },
  20 * 60_000,
);

test("ledger isolation: an explicit ledger directory (environment variable) receives entries instead of the main checkout's ledger, and the summary command reads from it", () => {
  const temporary = join(repository, '.temp');
  mkdirSync(temporary, { recursive: true });
  const directory = mkdtempSync(join(temporary, 'ledger-isolation-'));
  try {
    const checkout = mainCheckout(repository);
    const env = { ...process.env, [CHECK_LEDGER_DIRECTORY_ENV]: directory };
    const entry: CheckLedgerEntry = {
      runId: randomUUID(),
      argv: ['ledger-isolation-sentinel'],
      start: '2026-10-30T12:00:00.000Z',
      end: '2026-10-30T12:00:10.000Z',
      terminalStatus: 'passed',
    };
    const defaultPath = ledgerPath(entry, checkout, {});
    expect(existsSync(defaultPath)).toBe(false);
    writeLedger(entry, checkout, undefined, env);
    expect(checkLedgerDirectory(checkout, env)).toBe(directory);
    expect(JSON.parse(readFileSync(ledgerPath(entry, checkout, env), 'utf8'))).toEqual(entry);
    expect(existsSync(defaultPath)).toBe(false);
    const result = spawnSync(
      process.execPath,
      ['scripts/check-ledger.ts', 'summary', '--since', entry.start, '--until', entry.end!],
      { cwd: repository, encoding: 'utf8', env },
    );
    expect(result.status, result.stderr).toBe(0);
    const summary = JSON.parse(result.stdout);
    expect(Object.keys(summary.byCommandClass)).toEqual(['other']);
    expect(summary.byCommandClass.other.checkHours).toBeCloseTo(10 / 3600);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

function filesUnder(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(path) : [path];
  });
}

describe('ledger', () => {
  test('writes running and finished entries atomically under the UTC day', () => {
    const root = mkdtempSync(join(tmpdir(), 'check-ledger-'));
    try {
      const entry: CheckLedgerEntry = {
        runId: 'physical-1',
        argv: ['bun', 'test'],
        start: '2026-10-29T12:00:00.000Z',
        terminalStatus: 'running',
      };
      writeLedger(entry, root);
      expect(JSON.parse(readFileSync(ledgerPath(entry, root), 'utf8')).terminalStatus).toBe('running');
      entry.end = '2026-10-29T12:00:10.000Z';
      entry.terminalStatus = 'passed';
      writeLedger(entry, root);
      expect(JSON.parse(readFileSync(ledgerPath(entry, root), 'utf8')).terminalStatus).toBe('passed');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('clips running entries to the window and totals memory integral', () => {
    const entry: CheckLedgerEntry = {
      runId: 'r',
      argv: ['bun', 'test', 'scripts/a.test.ts'],
      start: '2026-10-29T00:00:00Z',
      terminalStatus: 'running',
      memoryGiBSeconds: 7200,
      samplingIntervalSeconds: 5,
      sampleCount: 10,
    };
    const result = summarize([entry], new Date('2026-10-29T00:00:05Z'), new Date('2026-10-29T00:00:10Z')) as any;
    expect(result.byCommandClass['script and control-plane tests'].checkHours).toBeCloseTo(5 / 3600);
    expect(result.byCommandClass['script and control-plane tests'].memoryGiBHours).toBeCloseTo(1);
    expect(result.limits.samplingIntervalSeconds).toBe(5);
  });
});
