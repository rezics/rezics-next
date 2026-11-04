import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { WorkerJob } from './job.ts';
import { workerPrompt } from './launch.ts';
import { settle } from './settle.ts';
import type { Attempt, Task } from './types.ts';
import { harness, markdown } from './test-support.ts';

const waitingCli = `#!/usr/bin/env bun
import { existsSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
const root = process.cwd();
if (process.argv.includes('resume')) {
  writeFileSync(join(root, '.temp/goal/resume-args.json'), JSON.stringify(process.argv));
  writeFileSync(join(root, '.temp/goal/resume-started'), 'yes');
  await Bun.sleep(150);
  writeFileSync('result.txt', 'resumed');
  spawnSync('git', ['add', 'result.txt']);
  spawnSync('git', ['commit', '-m', 'Resume check worker']);
  console.log(JSON.stringify({type:'thread.started',thread_id:'wake-session'}));
  console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'RESULT: success'}}));
} else {
  console.log(JSON.stringify({type:'thread.started',thread_id:'wake-session'}));
  console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify({status:'waiting',summary:'checks running',checks:['check-a','check-b']})}}));
}
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:10,output_tokens:2}}));
`;
const adoptedWaitingCli = `#!/usr/bin/env bun
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
const root = process.cwd();
writeFileSync(join(root, '.temp/goal/resume-args.json'), JSON.stringify(process.argv));
writeFileSync(join(root, '.temp/goal/resume-started'), 'yes');
console.log(JSON.stringify({type:'thread.started',thread_id:'wake-session'}));
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'RESULT: success'}}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:10,output_tokens:2}}));
`;

async function waitFor(path: string): Promise<void> {
  for (let n = 0; n < 300; n++) {
    if (existsSync(path)) return;
    await Bun.sleep(10);
  }
  throw new Error(`timed out waiting for ${path}`);
}

async function startWaitingAttempt(h: ReturnType<typeof harness>, checks = ['check-a', 'check-b']) {
  const task = h.tasks.dispatch(h.briefFile);
  const startedAt = new Date().toISOString();
  const attempt = h.store.nextAttempt({ taskId: task.id, attempt: 0 }, (n): Attempt => ({
    taskId: task.id,
    attempt: n,
    state: 'pending',
    profile: { cli: 'codex', model: 'gpt-6-luna', effort: 'high', poolClass: 'codex' },
    pool: 'fixture',
    tableVersion: 'fixture',
    experiment: null,
    startedAt,
    endedAt: null,
    process: null,
    driver: null,
    logPath: join(h.settings.stateDirectory, 'runs', task.id, `${n}.jsonl`),
    evidencePath: join(h.settings.stateDirectory, 'evidence', task.id, String(n)),
    auxiliaryProcesses: [],
    session: null,
    fixRound: 0,
    consulted: false,
    previousFailure: null,
    failure: null,
    escalation: null,
    before: null,
    after: null,
    exitCode: null,
    result: '',
    blocker: null,
    approaches: [],
  }));
  mkdirSync(join(attempt.logPath, '..'), { recursive: true });
  writeFileSync(
    attempt.logPath,
    [
      { type: 'thread.started', thread_id: 'wake-session' },
      {
        type: 'item.completed',
        item: {
          type: 'agent_message',
          text: JSON.stringify({ status: 'waiting', summary: 'checks running', checks }),
        },
      },
    ]
      .map((event) => JSON.stringify(event))
      .join('\n') + '\n',
  );
  h.store.updateAttempt(attempt, (current) => {
    current.state = 'running';
  });
  h.store.updateTask(attempt, (current) => {
    current.state = 'running';
  });
  const landings: unknown[] = [];
  await settle(
    h.tasks,
    { attempt, exited: Promise.resolve({ code: 0, signal: null }) },
    { enqueue: (request) => landings.push(request) },
  );
  expect(landings).toHaveLength(0);
  return { task, ref: { taskId: task.id, attempt: 1 } };
}

test('same-session wake forwards the newly persisted minimal source-result and compiler policy with terminal evidence', async () => {
  const h = harness(waitingCli);
  try {
    const id = randomUUID();
    const { task, ref } = await startWaitingAttempt(h, [id]);
    const session = h.store.attempt(ref).session;
    const results = join(task.worktree, '.temp/goal/checks/results');
    mkdirSync(results, { recursive: true });
    writeFileSync(join(results, `${id}.json`), JSON.stringify({ status: 'finished', exitStatus: 0 }));
    writeFileSync(join(h.settings.stateDirectory, 'verification-mode'), 'minimal\n');

    const job = new WorkerJob(h.tasks, { enqueue() {} }, { deliver() {} });
    const recovery = job.recoverOrphans();
    await waitFor(join(task.worktree, '.temp/goal/resume-started'));
    const args = JSON.parse(readFileSync(join(task.worktree, '.temp/goal/resume-args.json'), 'utf8')) as string[];
    await recovery;
    const prompt = args.at(-1)!;
    expect(args).toContain('resume');
    expect(args).toContain(session!);
    expect(h.store.task(task.id).currentAttempt).toBe(ref.attempt);
    expect(h.store.attempt(ref).state).toBe('exited');
    expect(prompt).toContain(h.store.task(task.id).brief.markdown);
    expect(prompt).toContain(`check ${id}: exit status 0; passed;`);
    expect(prompt).toContain('return success (blocker null, `"checks":[]`)');
    expect(prompt).toContain('the deferred acceptance, which is neither a blocker nor a reason to wait');
    expect(prompt).toContain('Unfinished work is not a blocker');
    expect(prompt).toContain('services/kernel and services/auth may use the compiler database or a check host');
    expect(prompt).toContain('Wait for a long command, even one queued for a test slot, in its open session');
    expect(prompt).not.toContain('run your acceptance command once');
  } finally {
    h.dispose();
  }
});

test('a waiting session uses the registered local command on wake even when its saved contract names the old remote route', async () => {
  const h = harness(waitingCli);
  try {
    const localMarkdown = markdown.replace(
      '  command: [bun, test]',
      '  command: [bun, test, apps/web/tests/shell-menus.test.ts]\n  placement: local',
    );
    writeFileSync(h.briefFile, localMarkdown);
    const { task, ref } = await startWaitingAttempt(h);
    mkdirSync(join(task.worktree, 'scripts'), { recursive: true });
    writeFileSync(join(task.worktree, 'scripts/worker-check.ts'), '');
    const results = join(task.worktree, '.temp/goal/checks/results');
    mkdirSync(results, { recursive: true });
    for (const id of ['check-a', 'check-b'])
      writeFileSync(join(results, `${id}.json`), JSON.stringify({ exitStatus: 0, status: 'finished' }));

    const job = new WorkerJob(h.tasks, { enqueue() {} }, { deliver() {} });
    const recovery = job.recoverOrphans();
    await waitFor(join(task.worktree, '.temp/goal/resume-started'));
    const args = JSON.parse(readFileSync(join(task.worktree, '.temp/goal/resume-args.json'), 'utf8')) as string[];
    const prompt = args.at(-1)!;
    expect(prompt).toContain(
      "bun scripts/worker-check.ts --local -- 'bun' 'test' 'apps/web/tests/shell-menus.test.ts'",
    );
    expect(prompt).toContain('The acceptance placement is local');
    expect(prompt).toContain('Ignore older prompt, saved session, remote invocation or `--wait` recipes');
    expect(prompt).toContain('Never wait for it yourself: no `--wait`');
    expect(prompt).not.toContain('bun scripts/worker-check.ts -- <command...>');
    await recovery;
    expect(h.store.attempt(ref).state).toBe('exited');
  } finally {
    h.dispose();
  }
});

test('an adopted waiting attempt without a resumable session gets the current local protocol', async () => {
  const h = harness(adoptedWaitingCli);
  try {
    writeFileSync(
      h.briefFile,
      markdown.replace(
        '  command: [bun, test]',
        '  command: [bun, test, apps/web/tests/shell-menus.test.ts]\n  placement: local',
      ),
    );
    const { task, ref } = await startWaitingAttempt(h);
    h.store.updateAttempt(ref, (attempt) => {
      attempt.session = null;
    });
    mkdirSync(join(task.worktree, 'scripts'), { recursive: true });
    writeFileSync(join(task.worktree, 'scripts/worker-check.ts'), '');
    const results = join(task.worktree, '.temp/goal/checks/results');
    mkdirSync(results, { recursive: true });
    for (const id of ['check-a', 'check-b'])
      writeFileSync(join(results, `${id}.json`), JSON.stringify({ exitStatus: 0, status: 'finished' }));

    const job = new WorkerJob(h.tasks, { enqueue() {} }, { deliver() {} });
    const recovery = job.recoverOrphans();
    await waitFor(join(task.worktree, '.temp/goal/resume-started'));
    const args = JSON.parse(readFileSync(join(task.worktree, '.temp/goal/resume-args.json'), 'utf8')) as string[];
    const prompt = args.at(-1)!;
    expect(prompt).toContain(
      "bun scripts/worker-check.ts --local -- 'bun' 'test' 'apps/web/tests/shell-menus.test.ts'",
    );
    expect(prompt).toContain('The acceptance placement is local');
    expect(prompt).toContain('Ignore older prompt, saved session, remote invocation or `--wait` recipes');
    expect(prompt).toContain('Never wait for it yourself: no `--wait`');
    expect(prompt.indexOf('The acceptance placement is local')).toBeGreaterThan(
      prompt.indexOf('The task contract follows:'),
    );
    await recovery;
  } finally {
    h.dispose();
  }
});

test('a same-session wake preserves the focused Web command argv under the managed local wrapper', async () => {
  const h = harness(waitingCli);
  try {
    const selector =
      'every non-English page story contains no untranslated message or type-name text|localized page choices|a subject page renders the subject in the page language on the server|labels fall back to English and keep their own language';
    const command = [
      'env',
      '-u',
      'KERNEL_ORIGIN',
      'PUBLIC_ORIGIN=http://127.0.0.1:3000',
      'bun',
      'apps/web/scripts/focused.ts',
      '--private-network',
      '--',
      'bun',
      'test',
      'tests/page-stories.test.ts',
      'tests/localized-page-choices.test.ts',
      'tests/subject.test.ts',
      '-t',
      selector,
    ];
    writeFileSync(
      h.briefFile,
      markdown.replace('  command: [bun, test]', `  command: ${JSON.stringify(command)}\n  placement: local`),
    );
    const { task, ref } = await startWaitingAttempt(h);
    mkdirSync(join(task.worktree, 'scripts'), { recursive: true });
    writeFileSync(join(task.worktree, 'scripts/worker-check.ts'), '');
    const results = join(task.worktree, '.temp/goal/checks/results');
    mkdirSync(results, { recursive: true });
    for (const id of ['check-a', 'check-b'])
      writeFileSync(join(results, `${id}.json`), JSON.stringify({ exitStatus: 0, status: 'finished' }));

    const job = new WorkerJob(h.tasks, { enqueue() {} }, { deliver() {} });
    const recovery = job.recoverOrphans();
    await waitFor(join(task.worktree, '.temp/goal/resume-started'));
    const args = JSON.parse(readFileSync(join(task.worktree, '.temp/goal/resume-args.json'), 'utf8')) as string[];
    const prompt = args.at(-1)!;
    await recovery;
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    const expected = `bun scripts/worker-check.ts --local -- ${command.map(quote).join(' ')}`;
    expect(h.store.task(task.id).brief.acceptance).toMatchObject({ placement: 'local', command });
    expect(prompt).toContain(expected);
    expect(prompt.match(/bun scripts\/worker-check\.ts --local --/g)).toHaveLength(1);
    expect(prompt).toContain('This prompt and these facts supersede saved sessions');
    expect(h.store.attempt(ref).state).toBe('exited');
  } finally {
    h.dispose();
  }
});

test('waiting workers release their cap slot and resume the same session with every completed check result', async () => {
  const h = harness(waitingCli);
  try {
    const { task, ref } = await startWaitingAttempt(h);
    const job = new WorkerJob(h.tasks, { enqueue() {} }, { deliver() {} });
    const waiting = h.store.attempt(ref);
    expect(waiting.state).toBe('waiting');
    expect(waiting.checks).toEqual(['check-a', 'check-b']);
    expect(waiting.session).toBe('wake-session');
    expect(waiting.endedAt).toBeNull();
    expect(h.store.runningAttemptsCount()).toBe(0);

    const resultDirectory = join(task.worktree, '.temp/goal/checks/results');
    mkdirSync(resultDirectory, { recursive: true });
    for (const [id, status, summary] of [
      ['check-a', 0, 'passed'],
      ['check-b', 9, 'assertion failed: expected 2'],
    ] as const)
      writeFileSync(
        join(resultDirectory, `${id}.json`),
        JSON.stringify({ exitStatus: status, failureSummary: summary, logPath: `.temp/goal/checks/${id}.log` }),
      );

    const recovery = job.recoverOrphans();
    await waitFor(join(task.worktree, '.temp/goal/resume-started'));
    expect(h.store.attempt(ref).state).toBe('running');
    expect(h.store.runningAttemptsCount()).toBe(1);
    const args = JSON.parse(readFileSync(join(task.worktree, '.temp/goal/resume-args.json'), 'utf8')) as string[];
    expect(args).toContain('resume');
    expect(args).toContain('wake-session');
    const prompt = args.at(-1)!;
    expect(prompt).toContain('check-a: exit status 0; passed; log path .temp/goal/checks/check-a.log');
    expect(prompt).toContain(
      'check-b: exit status 9; assertion failed: expected 2; log path .temp/goal/checks/check-b.log',
    );
    await recovery;
    expect(readFileSync(join(task.worktree, 'result.txt'), 'utf8')).toBe('resumed');
  } finally {
    h.dispose();
  }
});

test('same-session wake includes bounded evidence from only the exact terminal check logs', async () => {
  const h = harness(waitingCli);
  try {
    const ids = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    const [assertionId, longId, nestedId, misroutedId, missingId] = ids as [string, string, string, string, string];
    const { task, ref } = await startWaitingAttempt(h, ids);
    const waiting = h.store.attempt(ref);
    expect(waiting.session).toBe('wake-session');
    expect(waiting.checks).toEqual(ids);

    const checks = join(task.worktree, '.temp/goal/checks');
    const results = join(checks, 'results');
    const runs = join(checks, 'runs');
    mkdirSync(results, { recursive: true });
    mkdirSync(runs, { recursive: true });
    mkdirSync(join(checks, 'nested'), { recursive: true });
    const assertionLog = '.temp/goal/checks/worker-check-' + assertionId + '.log';
    const longLog = '.temp/goal/checks/worker-check-' + longId + '.log';
    const nestedLog = '.temp/goal/checks/nested/worker-check-' + nestedId + '.log';
    const missingLog = '.temp/goal/checks/worker-check-' + missingId + '.log';
    const staleAssertion = 'STALE_ATTEMPT_LOG_ASSERTION_MUST_NOT_BE_USED';
    const nestedAssertion = 'NESTED_UNRELATED_LOG_ASSERTION_MUST_NOT_BE_USED';
    const largeLogPrefix = 'TRUNCATED_PREFIX_ASSERTION_MUST_NOT_BE_INCLUDED';
    const assertion =
      'FAIL apps/web/tests/progress-pages-layout.test.ts:824: Subject picker is absent after unknown subjectId\n' +
      'AssertionError: expected Subject picker to remain available after unknown subjectId\n';
    writeFileSync(join(task.worktree, assertionLog), assertion);
    writeFileSync(
      join(task.worktree, longLog),
      Buffer.concat([
        Buffer.from(`${largeLogPrefix}\n`),
        Buffer.alloc(5000, 0xff),
        Buffer.from('\nFinal terminal log line\n'),
      ]),
    );
    writeFileSync(join(task.worktree, nestedLog), nestedAssertion);
    writeFileSync(waiting.logPath, `${readFileSync(waiting.logPath, 'utf8')}\n${staleAssertion}\n`);

    const command = ['bun', 'test', 'apps/web/tests/progress-pages-layout.test.ts'];
    const bodies = new Map<string, string>();
    for (const [index, id] of ids.entries()) {
      const log = [assertionLog, longLog, nestedLog, assertionLog, missingLog][index]!;
      const record = {
        id,
        cwd: task.worktree,
        argv: command,
        status: 'finished',
        exitCode: 1,
        log,
        runnerPid: process.pid,
        runnerHost: hostname(),
        failureSummary: index === 0 ? '1 failed, 396 assertions passed' : `check ${index + 1} failed`,
      };
      const body = JSON.stringify(record);
      bodies.set(id, body);
      writeFileSync(join(results, `${id}.json`), body);
      writeFileSync(join(runs, `${id}.json`), body);
    }
    const job = new WorkerJob(h.tasks, { enqueue() {} }, { deliver() {} });
    const recovery = job.recoverOrphans();
    await waitFor(join(task.worktree, '.temp/goal/resume-started'));
    const args = JSON.parse(readFileSync(join(task.worktree, '.temp/goal/resume-args.json'), 'utf8')) as string[];
    expect(args).toContain('resume');
    expect(args).toContain('wake-session');
    const prompt = args.at(-1)!;
    expect(prompt).toContain(
      `check ${assertionId}: exit status 1; 1 failed, 396 assertions passed; log path ${assertionLog}`,
    );
    expect(prompt).toContain(
      `check ${assertionId} failure evidence: command ${JSON.stringify(command)}; exit status 1; evidence path ${assertionLog}`,
    );
    expect(prompt).toContain('progress-pages-layout.test.ts:824: Subject picker is absent after unknown subjectId');
    expect(prompt).toContain('expected Subject picker to remain available after unknown subjectId');

    const excerptStart = prompt.indexOf(`BEGIN OWNED CHECK LOG EXCERPT ${longId}\n`);
    const excerptEnd = prompt.indexOf(`\nEND OWNED CHECK LOG EXCERPT ${longId}`, excerptStart);
    expect(excerptStart).toBeGreaterThanOrEqual(0);
    expect(excerptEnd).toBeGreaterThan(excerptStart);
    expect(
      Buffer.byteLength(prompt.slice(excerptStart + `BEGIN OWNED CHECK LOG EXCERPT ${longId}\n`.length, excerptEnd)),
    ).toBeLessThanOrEqual(4096);
    expect(prompt).toContain('truncated; the complete failure detail is unknown');
    expect(prompt).not.toContain(largeLogPrefix);

    const nestedDetail = prompt.split('\n').find((line) => line.startsWith(`check ${nestedId} failure evidence:`));
    expect(nestedDetail).toContain('excerpt unknown');
    expect(nestedDetail).toContain('original path ' + nestedLog);
    const misroutedLog = '.temp/goal/checks/worker-check-' + assertionId + '.log';
    const misroutedDetail = prompt
      .split('\n')
      .find((line) => line.startsWith(`check ${misroutedId} failure evidence:`));
    expect(misroutedDetail).toContain('excerpt unknown');
    expect(misroutedDetail).toContain('original path ' + misroutedLog);
    const missingDetail = prompt.split('\n').find((line) => line.startsWith(`check ${missingId} failure evidence:`));
    expect(missingDetail).toContain('excerpt unknown');
    expect(missingDetail).toContain('original path ' + missingLog);
    expect(prompt).not.toContain(nestedAssertion);
    expect(prompt).not.toContain(staleAssertion);
    await recovery;

    expect(h.store.task(task.id).currentAttempt).toBe(ref.attempt);
    expect(h.store.attempt(ref).session).toBe(waiting.session);
    expect(h.store.attempt(ref).checks).toEqual(ids);
    for (const id of ids) {
      expect(readFileSync(join(results, `${id}.json`), 'utf8')).toBe(bodies.get(id)!);
      expect(readFileSync(join(runs, `${id}.json`), 'utf8')).toBe(bodies.get(id)!);
    }
  } finally {
    h.dispose();
  }
});

test('same-session wake delivers a short recorded runtime cause even when the wrapper summary omits it', async () => {
  const h = harness(waitingCli);
  try {
    const id = randomUUID();
    const { task, ref } = await startWaitingAttempt(h, [id]);
    const checks = join(task.worktree, '.temp/goal/checks');
    const results = join(checks, 'results');
    const runs = join(checks, 'runs');
    mkdirSync(results, { recursive: true });
    mkdirSync(runs, { recursive: true });
    const log = `.temp/goal/checks/worker-check-${id}.log`;
    const cause = 'ReferenceError: DEFAULT_MAX_MS is not defined';
    const output = `${cause}\nCheck failed (exit 1).\n`;
    writeFileSync(join(task.worktree, log), output);
    const argv = ['bun', 'run', '--cwd', 'apps/web', 'typecheck'];
    const original = JSON.stringify({
      id,
      cwd: task.worktree,
      argv,
      status: 'finished',
      exitCode: 1,
      log,
      runnerPid: process.pid,
      runnerHost: hostname(),
      failureSummary: 'Check failed (exit 1).',
    });
    writeFileSync(join(results, `${id}.json`), original);
    writeFileSync(join(runs, `${id}.json`), original);
    const job = new WorkerJob(h.tasks, { enqueue() {} }, { deliver() {} });
    await job.recoverOrphans();
    const args = JSON.parse(readFileSync(join(task.worktree, '.temp/goal/resume-args.json'), 'utf8')) as string[];
    expect(args).toContain('resume');
    expect(args).toContain('wake-session');
    const prompt = args.at(-1)!;
    expect(prompt).toContain(
      `check ${id} failure evidence: command ${JSON.stringify(argv)}; exit status 1; evidence path ${log}`,
    );
    expect(prompt).toContain(`excerpt status complete (${Buffer.byteLength(output)} bytes)`);
    expect(prompt).toContain(
      `BEGIN OWNED CHECK LOG EXCERPT ${id}\n${output.trim()}\nEND OWNED CHECK LOG EXCERPT ${id}`,
    );
    expect(prompt).toContain(cause);
    expect(h.store.task(task.id).currentAttempt).toBe(ref.attempt);
    expect(h.store.attempt(ref).session).toBe('wake-session');
    expect(h.store.attempts(task.id)).toHaveLength(1);
    expect(readFileSync(join(results, `${id}.json`), 'utf8')).toBe(original);
    expect(readFileSync(join(runs, `${id}.json`), 'utf8')).toBe(original);
  } finally {
    h.dispose();
  }
});

test('a vanished check wakes a waiting attempt with the recovery fact', async () => {
  const h = harness(waitingCli);
  try {
    const { task } = await startWaitingAttempt(h);
    const job = new WorkerJob(h.tasks, { enqueue() {} }, { deliver() {} });
    const resultDirectory = join(task.worktree, '.temp/goal/checks/results');
    mkdirSync(resultDirectory, { recursive: true });
    writeFileSync(
      join(resultDirectory, 'check-a.json'),
      JSON.stringify({ exitStatus: 0, summary: 'passed', logPath: 'a.log' }),
    );
    const recovery = job.recoverOrphans();
    await waitFor(join(task.worktree, '.temp/goal/resume-started'));
    const args = JSON.parse(readFileSync(join(task.worktree, '.temp/goal/resume-args.json'), 'utf8')) as string[];
    expect(args.at(-1)).toContain('check check-b: run vanished or check host failed');
    await recovery;
  } finally {
    h.dispose();
  }
});

test('a check whose start record shows a live runner keeps the attempt waiting; a dead runner wakes it', async () => {
  const h = harness(waitingCli);
  try {
    const { task, ref } = await startWaitingAttempt(h);
    const job = new WorkerJob(h.tasks, { enqueue() {} }, { deliver() {} });
    const resultDirectory = join(task.worktree, '.temp/goal/checks/results');
    mkdirSync(resultDirectory, { recursive: true });
    writeFileSync(
      join(resultDirectory, 'check-a.json'),
      JSON.stringify({ exitCode: 0, status: 'finished', log: 'a.log' }),
    );
    // The record worker-check writes when a check starts, with this test's own (live) process as the runner.
    writeFileSync(
      join(resultDirectory, 'check-b.json'),
      JSON.stringify({ status: 'running', runnerPid: process.pid, runnerHost: hostname(), log: 'b.log' }),
    );
    await job.recoverOrphans();
    expect(h.store.attempt(ref).state).toBe('waiting');
    expect(existsSync(join(task.worktree, '.temp/goal/resume-started'))).toBe(false);

    const dead = Bun.spawnSync(['true']).pid;
    writeFileSync(
      join(resultDirectory, 'check-b.json'),
      JSON.stringify({ status: 'running', runnerPid: dead, runnerHost: hostname(), log: 'b.log' }),
    );
    const recovery = job.recoverOrphans();
    await waitFor(join(task.worktree, '.temp/goal/resume-started'));
    const args = JSON.parse(readFileSync(join(task.worktree, '.temp/goal/resume-args.json'), 'utf8')) as string[];
    expect(args.at(-1)).toContain(`check check-b: run vanished (runner ${dead} exited without a result)`);
    await recovery;
  } finally {
    h.dispose();
  }
});

test('worker instructions start detached checks, keep working, and return waiting without polling', () => {
  const h = harness();
  try {
    const task = {
      worktree: h.root,
      branch: 'worker/test',
      brief: { markdown: 'Do work', kind: 'implementation' },
    } as unknown as Task;
    mkdirSync(join(h.root, 'scripts'), { recursive: true });
    writeFileSync(join(h.root, 'scripts/worker-check.ts'), '');
    const prompt = workerPrompt(task, undefined, undefined, [], h.root);
    expect(prompt).toContain('bun scripts/worker-check.ts -- <command...>');
    expect(prompt).toContain('run your acceptance command once after your last relevant edit');
    expect(prompt).toContain('end the turn at once with `{"status":"waiting","checks":["<bare UUID>"]}`');
    expect(prompt).toContain('using that bare UUID');
    expect(prompt).toContain('Never wait for it yourself: no `--wait` (obsolete, whatever older sessions say)');
    expect(prompt).toContain('never start a duplicate');
    expect(prompt).toContain(
      'Do not run the root typecheck or other regression suites yourself; the landing runs them.',
    );
    const pollingInstructions = prompt
      .split(/(?<=[.!?])\s+/)
      .filter(
        (sentence) =>
          /\b(?:poll(?:ing)?|--wait)\b/i.test(sentence) &&
          !/\b(?:do not|don't|never|obsolete|superseded|previous session may contain)\b/i.test(sentence),
      );
    expect(pollingInstructions).toEqual([]);
    expect(prompt).not.toContain('{"status":"waiting","checks":["<id>",...]}');
    expect(prompt).not.toContain('Never poll');
  } finally {
    h.dispose();
  }
});
