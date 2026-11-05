import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { defaultPolicy } from './policy.ts';
import { tempDirectory } from './test-support.ts';
import { observeWorkerChecks } from './worker-check-observation.ts';

function writeRecord(worktree: string, id: string, body: unknown, kind: 'results' | 'runs' = 'results'): void {
  const directory = join(worktree, '.temp/goal/checks', kind);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, `${id}.json`), JSON.stringify(body));
}

test('ordinary observation stays pending for live local, remote, queued and sibling running records, then resumes with nested failure evidence and vanished-result facts', () => {
  const worktree = tempDirectory();
  const task = { worktree };
  const policy = defaultPolicy.worker;
  const liveId = randomUUID();
  const remoteId = randomUUID();
  const queuedId = randomUUID();
  const failedId = randomUUID();
  const vanishedId = randomUUID();
  const dead = Bun.spawnSync(['true']).pid;

  writeRecord(worktree, liveId, { status: 'running', runnerPid: process.pid, runnerHost: hostname(), log: 'live.log' });
  expect(observeWorkerChecks(task, [liveId], policy)).toEqual({ status: 'pending' });

  writeRecord(worktree, remoteId, {
    status: 'running',
    runnerPid: dead,
    runnerHost: 'remote-check-host',
    log: 'remote.log',
  });
  expect(observeWorkerChecks(task, [remoteId], policy)).toEqual({ status: 'pending' });

  writeRecord(worktree, queuedId, { state: 'queued', logPath: 'queued.log' }, 'runs');
  expect(observeWorkerChecks(task, [queuedId], policy)).toEqual({ status: 'pending' });

  writeRecord(worktree, failedId, { result: { exitStatus: 0, failureSummary: 'passed', logPath: 'ok.log' } });
  expect(observeWorkerChecks(task, [failedId, liveId], policy)).toEqual({ status: 'pending' });

  const log = `.temp/goal/checks/worker-check-${failedId}.log`;
  const excerpt = 'FAIL apps/web/tests/example.test.ts:12: expected 2\nAssertionError: original failure';
  mkdirSync(join(worktree, '.temp/goal/checks'), { recursive: true });
  writeFileSync(join(worktree, log), excerpt);
  writeRecord(worktree, failedId, {
    result: {
      id: failedId,
      cwd: worktree,
      argv: ['bun', 'test'],
      status: 'finished',
      exitCode: 1,
      log,
      runnerPid: process.pid,
      runnerHost: hostname(),
      failureSummary: '1 failed',
    },
  });
  const observed = observeWorkerChecks(task, [failedId, vanishedId], policy);
  expect(observed.status).toBe('terminal');
  const resumeText = observed.status === 'terminal' ? observed.resumeText : '';
  expect(resumeText).toContain('The checks completed or failed to run. Resume this same session');
  expect(resumeText).toContain(`check ${failedId}: exit status 1; 1 failed; log path ${log}`);
  expect(resumeText).toContain(`FAIL apps/web/tests/example.test.ts:12: expected 2`);
  expect(resumeText).toContain('AssertionError: original failure');
  expect(resumeText).toContain(
    `check ${vanishedId}: run vanished or check host failed before writing a result; exit status unavailable; log path unavailable`,
  );
});

test('a finished check names its whole log, copied into the worktree past the excerpt bound', () => {
  const worktree = tempDirectory();
  const id = randomUUID();
  // The runner names a physical run's log after its check id, then its start time and a random suffix.
  const log = `.temp/goal/checks/worker-check-${id}-2026-11-05T19-00-00.000Z-0a1b2c3d.log`;
  const output = `${'compiling module\n'.repeat(600)}FAIL apps/web/tests/example.test.ts:12: expected 2\n`;
  mkdirSync(join(worktree, '.temp/goal/checks'), { recursive: true });
  writeFileSync(join(worktree, log), output);
  writeRecord(worktree, id, {
    id,
    cwd: worktree,
    argv: ['bun', 'test'],
    status: 'finished',
    exitCode: 1,
    log,
    runnerPid: process.pid,
    runnerHost: hostname(),
  });
  const observed = observeWorkerChecks({ worktree }, [id], defaultPolicy.worker);
  expect(observed.status).toBe('terminal');
  const resumeText = observed.status === 'terminal' ? observed.resumeText : '';
  expect(resumeText).toContain(`full log .temp/check-logs/${id}.log`);
  expect(resumeText).toContain('fix the cause, and rerun the check');
  expect(readFileSync(join(worktree, '.temp/check-logs', `${id}.log`), 'utf8')).toBe(output);
});
