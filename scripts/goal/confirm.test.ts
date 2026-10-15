import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { expect, test } from 'bun:test';
import { loadOutcomes } from '../qa/cases/outcomes.ts';
import { parseJUnit } from '../qa/acceptance.ts';
import { releaseDirectoryLease, tryAcquireDirectoryLease } from '../qa/process/lease.ts';
import { confirmationRunning, confirmationStatus, parseConfirmationArgs, runConfirmation, scheduleConfirmation } from './confirm.ts';
import { cellReading, cellReadings, latestConfirmation } from './confirmed.ts';
import type { ConfirmationOptions } from './confirm.ts';
import type { Execution } from './regress.ts';

function fixture() {
  mkdirSync('.temp', { recursive: true });
  const directory = mkdtempSync(join(import.meta.dir, '../../.temp/confirm-'));
  const git = (...args: string[]) => {
    const result = spawnSync('git', args, { cwd: directory, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Confirmation fixture'); git('config', 'user.email', 'fixture@example.invalid');
  const write = (path: string, source: string) => {
    mkdirSync(dirname(join(directory, path)), { recursive: true }); writeFileSync(join(directory, path), source);
  };
  write('.gitignore', '.temp/\n');
  const states = ['pass', 'fail', 'still', 'now', 'skip'] as const;
  for (const state of states) {
    const pending = state === 'still' || state === 'now';
    const title = `books/${state} / visitor: gets the outcome`;
    write(`scripts/qa/cases/outcomes/${state}.ts`, `import { rowOutcomes, proved, pending } from ${JSON.stringify(join(import.meta.dir, '../qa/cases/outcome-cells.ts'))};
      export default rowOutcomes('books/${state}', { visitor: ${pending ? 'pending' : 'proved'}('gets the outcome') });`);
    write(`tests/qa/integration/outcomes/books/${state}.test.ts`, `import { test, expect } from 'bun:test';
      test${state === 'skip' ? '.skip' : pending ? '.failing' : ''}(${JSON.stringify(title)}, () => {
        expect(${state === 'fail' || state === 'still' ? 'false' : 'true'}).toBe(true);
      });`);
    // The declaration loader accepts skipped execution through an ordinary registered title.
    if (state === 'skip') write(`tests/qa/integration/outcomes/books/${state}.test.ts`, `import { test } from 'bun:test';
      test(${JSON.stringify(title)}, () => {});`);
  }
  git('add', '.'); git('commit', '-qm', 'Declared outcomes');
  const commit = git('rev-parse', 'HEAD');
  const stateDir = join(directory, '.temp/state');
  const checkoutRoot = join(import.meta.dir, '../../.temp/c');
  const options: ConfirmationOptions = { repo: directory, stateDir, checkoutRoot, slots: 2,
    prepare: async () => ({ ok: true, artifactPaths: [] }), outcomeRegistry: async checkout =>
      [...(await loadOutcomes({ root: checkout, registry: states.map(capability => ({ kind: 'books', capability })) })).values()] };
  return { directory, stateDir, commit, options, git, write, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

test('user settings can disable scheduled confirmation without changing runtime state', () => {
  mkdirSync('.temp', { recursive: true });
  const directory = mkdtempSync(join(import.meta.dir, '../../.temp/confirm-settings-'));
  const stateDir = join(directory, '.temp/goal-orchestration');
  try {
    mkdirSync(join(directory, '.goalctl'), { recursive: true });
    writeFileSync(join(directory, '.goalctl/settings.user.json'), JSON.stringify({ version: 1, confirmIntervalMinutes: 0 }));
    let spawned = false;
    expect(scheduleConfirmation({ repo: directory, stateDir, spawn: () => { spawned = true; return process.pid; } })).toBe(false);
    expect(spawned).toBe(false);
    expect(existsSync(join(stateDir, 'confirm-last-start'))).toBe(false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('confirmation pins Main declarations, runs actual failing tests under slots, and records the five readings', async () => {
  const f = fixture();
  let active = 0;
  let peak = 0;
  const used: string[] = [];
  try {
    f.git('checkout', '-qb', 'worker');
    f.write('scripts/qa/cases/outcomes/pass.ts', 'throw new Error("Worker declarations are not Main");');
    f.git('commit', '-qam', 'Worker-only change');
    const manifest = await runConfirmation({ ...f.options, runId: 'fixture', runner: async (checkout, batch, directory) => {
      peak = Math.max(peak, ++active);
      used.push(batch.files[0]!);
      expect(spawnSync('git', ['rev-parse', 'HEAD'], { cwd: checkout, encoding: 'utf8' }).stdout.trim()).toBe(f.commit);
      mkdirSync(directory, { recursive: true });
      const xml = join(directory, 'integration.xml');
      const started = Date.now();
      try {
        const child = Bun.spawn([process.execPath, join(import.meta.dir, 'goalctl.ts'), 'slot', '--', process.execPath,
          'test', '--reporter=junit', `--reporter-outfile=${xml}`, ...batch.files], {
          cwd: checkout, env: { ...process.env, GOAL_QA_SLOTS: '2', GOAL_MEMORY_FLOOR_GIB: '0',
            GOAL_IN_SLOT: '0', GOAL_UNIT_GATE_SLOTS: '2' }, stdout: 'pipe', stderr: 'pipe' });
        const [code, , stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
        expect(existsSync(xml), stderr).toBe(true);
        let source = readFileSync(xml, 'utf8');
        if (batch.files[0]!.includes('/skip.')) {
          source = source.replace(/<testcase([^>]*?)\/>/g, '<testcase$1><skipped/></testcase>');
          writeFileSync(xml, source);
        }
        const tests = parseJUnit(source, 'integration', { root: checkout });
        return { code, outcomes: { [batch.files[0]!]: tests.some(test => test.failed) ? 'failed'
          : tests.some(test => test.skipped) ? 'missing' : 'passed' }, artifactPaths: [directory],
        queueMs: 0, testMs: Date.now() - started, totalMs: Date.now() - started, evidence: source };
      } finally { active--; }
    } });
    expect(peak).toBe(2);
    expect(used).toHaveLength(5);
    expect(new Set(used).size).toBe(5);
    expect(manifest.atCommit).toBe(f.commit);
    expect(manifest.status).toBe('failed');
    expect(existsSync(manifest.checkout)).toBe(false);
    const record = latestConfirmation(f.stateDir)!;
    expect(record.outcomes.map(cellReading).sort(), manifest.batches.find(batch => batch.files[0]!.includes('/now.'))?.attempts[0]?.evidence)
      .toEqual([...cellReadings].sort());
    expect(confirmationStatus(f.stateDir)).toContain('Running: no');
    expect(confirmationStatus(f.stateDir)).toContain(f.commit);
    expect(readFileSync(join(f.stateDir, 'confirm/fixture/confirmed.json'), 'utf8')).toContain(f.commit);
    const slotRoot = join(f.directory, '.temp/goal-orchestration/qa-slots');
    for (const name of ['0', '1']) expect(existsSync(join(slotRoot, name))).toBe(false);
  } finally { f.cleanup(); }
}, 60_000);

test('recording copies each attempt before checkout cleanup and quarantines files with any unpassed cell', async () => {
  const f = fixture();
  const sources = new Set<string>();
  try {
    const manifest = await runConfirmation({ ...f.options, record: '.temp/answers', runId: 'recording',
      outcomeRegistry: async checkout => {
        const rows = await f.options.outcomeRegistry!(checkout);
        const row = rows.find(row => row.rowId === 'books/fail')!;
        row.cells.member = { ...row.cells.visitor! };
        return rows;
      },
      runner: async (checkout, batch, directory, _shards, _slots, _artifacts, options) => {
        const source = options?.env?.OUTCOME_RECORD_DIR;
        expect(source).toBeDefined();
        sources.add(source!);
        const name = batch.files[0]!.split('/').at(-1)!.replace('.test.ts', '');
        // The same row name in different files proves concurrent lanes cannot contaminate attribution.
        const record = join(checkout, source!, 'books/shared.json');
        mkdirSync(dirname(record), { recursive: true });
        writeFileSync(record, JSON.stringify({ source: name }));
        const title = `books/${name} / visitor: gets the outcome`;
        const detail = name === 'skip' ? '<skipped/>' : '';
        const second = name === 'fail' ? `<testcase file="${batch.files[0]}"
          name="books/fail / member: gets the outcome"><failure>assertion failed</failure></testcase>` : '';
        mkdirSync(directory, { recursive: true });
        writeFileSync(join(directory, 'integration.xml'), `<testsuites><testsuite>
          <testcase file="${batch.files[0]}" name="${title}">${detail}</testcase>
          ${second}
          </testsuite></testsuites>`);
        await Bun.sleep(10);
        // Even a green process/file result cannot publish a record when a later cell fails.
        return { code: 0, outcomes: { [batch.files[0]!]: 'passed' },
          artifactPaths: [directory], queueMs: 0, testMs: 0, totalMs: 0 };
      } });
    expect(sources.size).toBe(5);
    expect(existsSync(manifest.checkout)).toBe(false);
    expect(manifest.records).toHaveLength(5);
    expect(manifest.records!.filter(record => record.status === 'passed')).toHaveLength(1);
    for (const record of manifest.records!) {
      const name = record.file.split('/').at(-1)!.replace('.test.ts', '');
      expect(JSON.parse(readFileSync(join(f.directory, record.record), 'utf8'))).toEqual({ source: name });
      expect(record.record.includes('/failed/')).toBe(name !== 'pass');
    }
    const saved = JSON.parse(readFileSync(join(f.stateDir, 'confirm/recording/manifest.json'), 'utf8'));
    expect(saved.records).toEqual(manifest.records);
  } finally { f.cleanup(); }
});

test('record destinations reject traversal and symlink escapes before creating a pinned checkout', async () => {
  const f = fixture();
  try {
    mkdirSync(join(f.directory, '.temp'), { recursive: true });
    symlinkSync(f.directory, join(f.directory, '.temp/escape'));
    for (const record of ['answers', '.temp', '.temp/../answers', '.temp/escape/answers']) {
      await expect(runConfirmation({ ...f.options, record, runId: 'invalid-record',
        prepare: async () => { throw new Error('Must not prepare an invalid recording destination'); } }))
        .rejects.toThrow('--record');
      expect(confirmationRunning(f.stateDir)).toBe(false);
    }
  } finally { f.cleanup(); }
});

test('only a timeout is retried, once, after both primary lanes drain; failures release the lane', async () => {
  const f = fixture();
  const attempts = new Map<string, number>();
  let active = 0;
  const seen: string[] = [];
  try {
    await runConfirmation({ ...f.options, runId: 'retry', runner: async (_checkout, batch, directory) => {
      const file = batch.files[0]!;
      const n = (attempts.get(file) ?? 0) + 1; attempts.set(file, n);
      expect(++active).toBeLessThanOrEqual(2);
      seen.push(file);
      try {
        if (n === 2) { expect(active).toBe(1); expect(seen.length).toBe(6); }
        await Bun.sleep(20);
        if (file.includes('/fail.')) throw new Error('Fixture runner failure');
        const timeout = file.includes('/now.');
        mkdirSync(directory, { recursive: true });
        writeFileSync(join(directory, 'integration.xml'), `<testsuite><testcase file="${file}" name="books/now / visitor: gets the outcome"><failure type="TimeoutError" message="test timed out"/></testcase></testsuite>`);
        return { code: timeout ? 124 : 0, outcomes: { [file]: timeout ? 'failed' : 'passed' },
          artifactPaths: timeout ? [directory] : [], queueMs: 0, testMs: 20, totalMs: 20,
          classification: timeout ? 'deadline' : undefined } satisfies Execution;
      } finally { active--; }
    } });
    expect([...attempts.values()].sort()).toEqual([1, 1, 1, 1, 2]);
    expect(confirmationRunning(f.stateDir)).toBe(false);
  } finally { f.cleanup(); }
});

test('a dead confirmation lease is reclaimed, a live lease refuses a second run, and preflight failure leaves cells not run', async () => {
  const f = fixture();
  mkdirSync(f.stateDir, { recursive: true });
  const lock = join(f.stateDir, 'confirm.lock');
  try {
    const acquired = tryAcquireDirectoryLease(lock);
    expect(acquired).not.toBe('held');
    await expect(runConfirmation(f.options)).rejects.toThrow('already running');
    if (acquired !== 'held') acquired.release();
    mkdirSync(lock);
    writeFileSync(join(lock, 'identity.json'), JSON.stringify({ pid: 2147483647, token: 'dead' }));
    expect(confirmationRunning(f.stateDir)).toBe(false);
    await runConfirmation({ ...f.options, runId: 'preflight', prepare: async () => ({ ok: false, artifactPaths: [] }),
      runner: async () => { throw new Error('Must not run'); } });
    expect(latestConfirmation(f.stateDir)!.outcomes.every(cell => cellReading(cell) === 'not run')).toBe(true);
    expect(confirmationRunning(f.stateDir)).toBe(false);
  } finally { releaseDirectoryLease(lock, 'dead'); f.cleanup(); }
});

function fakeOutcomeRunner(): NonNullable<ConfirmationOptions['runner']> {
  return async (_checkout, batch, directory) => {
    const file = batch.files[0]!;
    const state = file.split('/').at(-1)!.replace('.test.ts', '');
    const detail = state === 'fail' ? '<failure message="assertion failed"/>'
      : state === 'now' ? '<failure message="test marked with .failing() did not throw"/>'
        : state === 'skip' ? '<skipped/>' : '';
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'integration.xml'), `<testsuite><testcase file="${file}" name="books/${state} / visitor: gets the outcome">${detail}</testcase></testsuite>`);
    return { code: detail.includes('failure') ? 1 : 0, outcomes: { [file]: detail.includes('failure') ? 'failed' : 'passed' },
      artifactPaths: [directory], queueMs: 0, testMs: 0, totalMs: 0 };
  };
}

test('an explicit revision pins its declarations, isolates the judge, and reports its cells during and after execution', async () => {
  const f = fixture();
  try {
    await runConfirmation({ ...f.options, runId: 'main', runner: fakeOutcomeRunner() });
    const judge = readFileSync(join(f.stateDir, 'confirmed.json'), 'utf8');
    f.git('checkout', '-qb', 'wave/1');
    f.write('scripts/qa/cases/outcomes/pass.ts', `import { rowOutcomes, notApplicable } from ${JSON.stringify(join(import.meta.dir, '../qa/cases/outcome-cells.ts'))};
      export default rowOutcomes('books/pass', { visitor: notApplicable('No action in this revision') });`);
    f.git('commit', '-qam', 'Wave declarations');
    const wave = f.git('rev-parse', 'HEAD');
    f.git('checkout', '-qb', 'worker');
    f.write('scripts/qa/cases/outcomes/pass.ts', 'throw new Error("Worker is not the wave");');
    f.git('commit', '-qam', 'Worker declarations');
    const used: string[] = [];
    const manifest = await runConfirmation({ ...f.options, at: 'wave/1', runId: 'wave', runner: async (...args) => {
      const [checkout, batch] = args;
      expect(spawnSync('git', ['rev-parse', 'HEAD'], { cwd: checkout, encoding: 'utf8' }).stdout.trim()).toBe(wave);
      expect(confirmationRunning(f.stateDir)).toBe(true);
      expect(scheduleConfirmation({ repo: f.directory, stateDir: f.stateDir, now: Date.now() + 10_000_000,
        spawn: () => { throw new Error('Scheduled confirmation must not start during the wave'); } })).toBe(false);
      expect(confirmationStatus(f.stateDir, Date.now(), 'wave')).toContain('Running: yes');
      expect(confirmationStatus(f.stateDir, Date.now(), 'wave')).toContain(wave);
      expect(confirmationStatus(f.stateDir, Date.now(), 'wave')).toContain('books/skip / visitor: not run (tests/qa/integration/outcomes/books/skip.test.ts)');
      used.push(batch.files[0]!);
      return fakeOutcomeRunner()(...args);
    } });
    expect(manifest.atCommit).toBe(wave);
    expect(used).toHaveLength(4);
    expect(used.every(file => !file.includes('/pass.'))).toBe(true);
    expect(readFileSync(join(f.stateDir, 'confirmed.json'), 'utf8')).toBe(judge);
    expect(latestConfirmation(join(f.stateDir, 'confirm/wave'))?.atCommit).toBe(wave);
    const summary = confirmationStatus(f.stateDir, Date.now(), 'wave');
    expect(summary).toContain('Running: no');
    expect(summary).toContain('passed: 0\nfailed: 1\npending and still failing: 1\npending and now passing: 1\nnot run: 1');
    expect(summary).toContain('books/fail / visitor: failed (tests/qa/integration/outcomes/books/fail.test.ts)');
    expect(summary).toContain('books/skip / visitor: not run (tests/qa/integration/outcomes/books/skip.test.ts)');
    expect(confirmationStatus(f.stateDir)).toContain(f.commit);
    expect(confirmationRunning(f.stateDir)).toBe(false);
  } finally { f.cleanup(); }
});

test('explicit lanes use the requested host width and reject widths outside the slot count', async () => {
  const f = fixture();
  try {
    for (const lanes of [0, 4, 1.5, Number.NaN]) {
      await expect(runConfirmation({ ...f.options, lanes, slots: 3, runId: 'invalid',
        prepare: async () => { throw new Error('Invalid width must not prepare'); } })).rejects.toThrow('QA slot count (3)');
      expect(confirmationRunning(f.stateDir)).toBe(false);
    }
    let active = 0;
    let peak = 0;
    const manifest = await runConfirmation({ ...f.options, lanes: 3, slots: 3, runId: 'lanes', runner: async (...args) => {
      peak = Math.max(peak, ++active);
      try { await Bun.sleep(20); return await fakeOutcomeRunner()(...args); }
      finally { active--; }
    } });
    expect(manifest.laneCount).toBe(3);
    expect(peak).toBe(3);
    expect(latestConfirmation(f.stateDir)?.runId).toBe('lanes');
  } finally { f.cleanup(); }
});

test('retained-source refusal checks the complete pinned selection before any confirmation test starts', async () => {
  const f = fixture();
  let tests = 0;
  try {
    const manifest = await runConfirmation({ ...f.options, runId: 'retained-refusal',
      retainedPreflight: async (checkout, files) => {
        expect(checkout).not.toBe(f.directory);
        expect(files).toHaveLength(5);
        expect(readFileSync(join(checkout, files[0]!), 'utf8')).toContain('books/');
        return { ok: false, elapsedMs: 12, sources: [{ source: 'realm', reason: 'collation drift: recorded 2.41, host 2.43',
          repair: 'task goal -- prepare-source realm', elapsedMs: 12 }] };
      }, runner: async () => { tests++; throw new Error('must not start a persona'); },
    });
    expect(tests).toBe(0);
    expect(manifest.status).toBe('failed');
    expect(manifest.retainedSources?.elapsedMs).toBe(12);
    expect(manifest.preflight.reason).toContain('recorded 2.41, host 2.43');
    expect(manifest.batches.every(batch => batch.state === 'pending' && batch.attempts.length === 0)).toBe(true);
  } finally { f.cleanup(); }
});

test('confirmation command accepts revision, lanes and run status without changing its defaults', () => {
  expect(parseConfirmationArgs([])).toEqual({});
  expect(parseConfirmationArgs(['--record', '.temp/answers'])).toEqual({ record: '.temp/answers' });
  expect(() => parseConfirmationArgs(['--status', '--record', '.temp/answers'])).toThrow();
  expect(() => parseConfirmationArgs(['--record', '.temp/a', '--record', '.temp/b'])).toThrow();
  expect(parseConfirmationArgs(['--at', 'wave/1', '--lanes', '3'])).toEqual({ at: 'wave/1', lanes: 3 });
  expect(parseConfirmationArgs(['--status', '--run', 'wave'])).toEqual({ status: true, run: 'wave' });
  expect(parseConfirmationArgs(['--status'])).toEqual({ status: true });
  for (const args of [['--lanes', '0'], ['--lanes', '1.5'], ['--lanes'], ['--at'], ['--run', 'wave'],
    ['--status', '--at', 'main'], ['--status', '--lanes', '2'], ['--status', '--run', '../main'], ['--unknown']])
    expect(() => parseConfirmationArgs(args)).toThrow();
});
