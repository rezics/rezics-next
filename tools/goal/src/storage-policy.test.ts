import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, symlinkSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { openDb } from './db.ts';
import { BoundedProcessError, runBoundedInstallProcess } from './install-process.ts';
import { readControlPolicy } from './policy.ts';
import { pruneStores } from './shared-dependencies.ts';
import { WorkerStore } from './store.ts';
import { temporaryDirectory } from './test-support.ts';

test('storage policy controls contention, check expiry and verifier retention without changing another caller', () => {
  const policy = readControlPolicy({
    storage: { sqliteBusyTimeoutMs: 17, checkResultTtlMs: 10 },
    verifier: { runRows: 1, findingRows: 1 },
  });
  const db = openDb(':memory:', policy.storage);
  const defaults = openDb(':memory:');
  try {
    const store = new WorkerStore(db, policy);
    expect(db.query('PRAGMA busy_timeout').get()).toEqual({ timeout: 17 });
    expect(defaults.query('PRAGMA busy_timeout').get()).toEqual({ timeout: 30000 });
    const result = {
      key: 'pass',
      unit: '.',
      passed: true as const,
      producer: 'test',
      host: 'test',
      duration: 1,
      logPath: '',
      time: 100,
      schemaVersion: 1,
    };
    store.checkResults.record(result, 100);
    expect(store.checkResults.lookup('pass', 110)?.passed).toBe(true);
    expect(store.checkResults.lookup('pass', 111)).toBeFalsy();
    store.checkResults.record({ ...result, time: 101 }, 100);
    expect(store.checkResults.lookup('pass', 100)).toBeFalsy();
    for (const key of ['old', 'new']) {
      store.saveDevVerifierRun({
        key,
        createdAt: '',
        evidence: { commit: key, command: [], passed: true, timedOut: false, output: '', logPath: '' },
      });
      store.saveDevVerifierFinding({
        rangeKey: key,
        identity: key,
        signature: key,
        baseCommit: 'base',
        headCommit: key,
        status: 'existing',
        result: 'fail',
        check: { command: [], closure: [] },
        assertion: 'failed',
        baseline: null,
        head: null,
        reason: '',
        createdAt: '',
      });
    }
    expect(store.devVerifierRun('old')).toBeUndefined();
    expect(store.devVerifierRun('new')).toBeDefined();
    expect(store.devVerifierFindings(99).map((finding) => finding.rangeKey)).toEqual(['new']);
  } finally {
    db.close();
    defaults.close();
  }
});

test('dependency policy reaches the independent supervisor and explicit process limits retain precedence', () => {
  const temporary = temporaryDirectory();
  const policy = readControlPolicy({
    dependencies: {
      install: { startupMs: 2000, runMs: 100, budgetMs: 3000, terminationMs: 500 },
      captureHeadBytes: 5,
      captureTailBytes: 4,
      pollMs: 5,
    },
  });
  const options = { command: process.execPath, cwd: temporary.path, step: 'fixture', policy };
  try {
    let failure: unknown;
    try {
      runBoundedInstallProcess({ ...options, args: ['-e', 'setTimeout(() => {}, 5000)'] });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(BoundedProcessError);
    expect((failure as BoundedProcessError).timedOut).toBe(true);
    const result = runBoundedInstallProcess({
      ...options,
      limits: { runMs: 2000 },
      args: ['-e', 'setTimeout(() => process.stdout.write("ABCDEFGHIJKLMN"), 200)'],
    });
    expect(result.stdout.startsWith('ABCDE\n[process output truncated')).toBe(true);
    expect(result.stdout.endsWith('KLMN')).toBe(true);
  } finally {
    temporary.close();
  }
});

test('dependency retention keeps active stores, newest stores and stores below the configured age', () => {
  const temporary = temporaryDirectory();
  const stores = join(temporary.path, 'stores'),
    worktrees = join(temporary.path, 'worktrees');
  const paths = ['a', 'b', 'c', 'd'].map((letter) => join(stores, letter.repeat(64)));
  try {
    for (const [index, path] of paths.entries()) {
      mkdirSync(join(path, 'node_modules/.bun'), { recursive: true });
      utimesSync(path, [1000, 1010, 1030, 1040][index]! / 1000, [1000, 1010, 1030, 1040][index]! / 1000);
    }
    const consumer = join(worktrees, 'task/node_modules');
    mkdirSync(consumer, { recursive: true });
    symlinkSync(join(paths[0]!, 'node_modules/.bun'), join(consumer, '.bun'));
    const policy = readControlPolicy({ dependencies: { retainedStores: 1, storeRetentionMs: 15 } });
    pruneStores(stores, worktrees, 1040, policy);
    expect(paths.map((path) => existsSync(path))).toEqual([true, false, true, true]);
    pruneStores(stores, worktrees, 1045, policy);
    expect(existsSync(paths[0]!)).toBe(true);
    expect(existsSync(paths[2]!)).toBe(false);
  } finally {
    temporary.close();
  }
});
