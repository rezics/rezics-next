import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { expect, test } from 'bun:test';
import { loadOutcomes } from '../qa/cases/outcomes.ts';
import { parseJUnit } from '../qa/acceptance.ts';
import { releaseDirectoryLease, tryAcquireDirectoryLease } from '../qa/process/lease.ts';
import { confirmationRunning, confirmationStatus, runConfirmation } from './confirm.ts';
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
