import { isolateTestSettings } from './fixtures/settings.ts';

import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pidAlive } from './ledger.ts';
import { GoalMailStore } from './mail.ts';
import { managerEvents } from './manager-commands.ts';
import { goalMeasures, measureLines } from './measures.ts';
import type { Attempt, Ledger, Task } from './types.ts';

isolateTestSettings();

const scratch = join(import.meta.dir, '../../.temp/no-handoff-tests');
const fixtures: { directory: string; task: Task; ledger: () => Ledger }[] = [];
const progress = "I'm still waiting for the verification runs.";

function fixture(text = progress, state: Task['state'] = 'running') {
  mkdirSync(scratch, { recursive: true });
  const directory = mkdtempSync(join(scratch, 'case-'));
  const git = spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: directory, encoding: 'utf8' });
  if (git.status !== 0) throw new Error(git.stderr);
  const stateDir = join(directory, '.temp/goal-orchestration');
  const run = join(stateDir, 'runs/G-001');
  const bin = join(directory, '.temp/bin');
  mkdirSync(run, { recursive: true });
  mkdirSync(bin);
  const launches = join(directory, '.temp/launches.jsonl');
  writeFileSync(join(bin, 'codex'), `#!/usr/bin/env bun
    import { appendFileSync, writeFileSync } from 'node:fs';
    const args = process.argv.slice(2);
    appendFileSync(${JSON.stringify(launches)}, JSON.stringify(args) + '\\n');
    writeFileSync(args[args.indexOf('-o') + 1], ${JSON.stringify(progress)});
    console.log(JSON.stringify({ type: 'thread.started', thread_id: 'same-session' }));
    console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 1 } }));
  `);
  chmodSync(join(bin, 'codex'), 0o755);
  const attempt: Attempt = { n: 1, engine: 'codex', effort: 'high', pid: 2147483647, session: '',
    output: join(run, 'attempt-1.json'), lastMessage: join(run, 'attempt-1.last.md'), startedAt: new Date().toISOString() };
  writeFileSync(attempt.lastMessage!, text);
  writeFileSync(attempt.output, JSON.stringify({ type: 'thread.started', thread_id: 'same-session' }) + '\n'
    + JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 1 } }) + '\n');
  const task: Task = { id: 'G-001', title: 'Finish the work', kind: 'implementation', effort: 'high',
    cases: [], paths: [], migrations: [], shared: [], depends: [], brief: join(directory, '.temp/brief.md'),
    worktree: directory, branch: 'main', base: '', state, goal: 'program', attempts: [attempt] };
  const ledgerPath = join(stateDir, 'ledger.json');
  const save = (ledger: Ledger) => writeFileSync(ledgerPath, JSON.stringify(ledger));
  save({ tasks: { [task.id]: task }, goals: { program: { manager: 'fixture-manager', startedAt: attempt.startedAt } } });
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, GOAL_ID: 'program', GOAL_MEMORY_FLOOR_GIB: '0',
    GOAL_MAX_WORKERS: '25', GOAL_SETTINGS_DIRECTORY: join(directory, '.goalctl'), GOAL_CODEX_HOME: join(directory, '.temp/codex'),
    GOAL_USAGE_FILE: join(directory, '.temp/usage.json') };
  const execute = async (source: string) => {
    const child = Bun.spawn([process.execPath, '-e', source], { cwd: directory, env, stdout: 'pipe', stderr: 'pipe' });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, stderr).toBe(0);
    return stdout;
  };
  const settle = () => execute(`import { settleTask } from ${JSON.stringify(join(import.meta.dir, 'settle.ts'))};
    await settleTask('G-001', { capacityWaitMs: 0 });`);
  const current = { directory, stateDir, task, attempt, launches, save, settle, execute,
    ledger: () => JSON.parse(readFileSync(ledgerPath, 'utf8')) as Ledger,
    events: () => {
      const mail = new GoalMailStore({ stateDir, goals: ['program'] });
      try { return managerEvents(stateDir, 'program', mail, directory).filter(event => event.key.startsWith('task:')); }
      finally { mail.close(); }
    } };
  fixtures.push(current);
  return current;
}

async function workerEnded(attempt: Attempt): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (pidAlive(attempt.pid, 'codex')) {
    if (Date.now() >= deadline) throw new Error('Fixture worker did not end');
    await Bun.sleep(10);
  }
}

afterEach(() => {
  for (const f of fixtures.splice(0)) {
    for (const attempt of f.ledger().tasks[f.task.id]?.attempts ?? []) {
      if (attempt.pid !== 2147483647) { try { process.kill(attempt.pid, 'SIGKILL'); } catch { /* exited */ } }
    }
    rmSync(f.directory, { recursive: true, force: true });
  }
});

test('a clean progress ending resumes the same session once, then records the reason and wakes its manager', async () => {
  const f = fixture();
  await f.settle();
  let task = f.ledger().tasks[f.task.id]!;
  expect(task.state).toBe('running');
  expect(task.attempts).toHaveLength(2);
  expect(task.attempts[0]!.endedAt).toBeDefined();
  const next = task.attempts[1]!;
  expect(next).toMatchObject({ session: 'same-session', engine: 'codex', effort: 'high', round: 'continuation', continuedFor: 'handoff' });
  expect(f.events()).toEqual([]);
  await workerEnded(next);
  const args = JSON.parse(readFileSync(f.launches, 'utf8').trim()) as string[];
  expect(args.slice(0, 3)).toEqual(['exec', 'resume', 'same-session']);
  const prompt = args.at(-1)!;
  expect(prompt).toContain('turn ended before the handoff');
  expect(prompt).toContain('nothing else changed');
  expect(prompt).toContain('command');
  expect(prompt).toContain('handoff');
  expect(prompt).toContain('yield_time_ms: 300000');
  await f.settle();
  task = f.ledger().tasks[f.task.id]!;
  expect(task.state).toBe('exited');
  expect(task.attempts).toHaveLength(2);
  expect(task.settlement?.reason).toBe('RESULT: missing');
  expect(f.events()).toEqual([{ key: 'task:G-001:2', body: 'RESULT: missing' }]);
  await f.settle();
  expect(f.ledger().tasks[f.task.id]!.attempts).toHaveLength(2);
});

for (const [text, state] of [
  ['RESULT: done', 'running'], ['RESULT: partial', 'running'], ['RESULT: blocked', 'running'],
  ['RESULT: invalid', 'running'], [progress, 'stopped'], [progress, 'cancelled'], [progress, 'verified'],
] as const) {
  test(`${state} task ending with ${text} is not continued`, async () => {
    const f = fixture(text, state);
    await f.settle();
    expect(f.ledger().tasks[f.task.id]!.attempts).toHaveLength(1);
    expect(existsSync(f.launches)).toBe(false);
  });
}

test('an already exited open task is continued', async () => {
  const f = fixture(progress, 'exited');
  await f.settle();
  expect(f.ledger().tasks[f.task.id]!.attempts[1]?.continuedFor).toBe('handoff');
});

test('a failed Codex turn with progress text is not a clean missing-handoff ending', async () => {
  const f = fixture();
  writeFileSync(f.attempt.output, JSON.stringify({ type: 'thread.started', thread_id: 'same-session' }) + '\n'
    + JSON.stringify({ type: 'turn.failed', error: { message: 'Authentication failed' } }) + '\n');
  await f.settle();
  expect(f.ledger().tasks[f.task.id]!.attempts).toHaveLength(1);
  expect(existsSync(f.launches)).toBe(false);
});

test('an incomplete Codex turn with progress text is not continued', async () => {
  const f = fixture();
  writeFileSync(f.attempt.output, JSON.stringify({ type: 'thread.started', thread_id: 'same-session' }) + '\n');
  await f.settle();
  expect(f.ledger().tasks[f.task.id]!.attempts).toHaveLength(1);
  expect(existsSync(f.launches)).toBe(false);
});

test('a dropped transport at its retry limit does not become a handoff continuation', async () => {
  const f = fixture();
  rmSync(f.attempt.lastMessage!);
  writeFileSync(f.attempt.output.replace(/\.json$/, '.err'), 'RetriableError: Connection stalled repeatedly\n');
  const ledger = f.ledger();
  ledger.tasks[f.task.id]!.attempts.push({ ...f.attempt, n: 2, round: 'continuation', continuedFor: 'transport' },
    { ...f.attempt, n: 3, round: 'continuation', continuedFor: 'transport' });
  f.save(ledger);
  await f.settle();
  expect(f.ledger().tasks[f.task.id]!.attempts).toHaveLength(3);
  expect(existsSync(f.launches)).toBe(false);
  expect(f.events()[0]?.body).toContain('worker handoff is missing or reports an error');
});

test('capacity refusals keep their own continuation even with progress text', async () => {
  const f = fixture();
  writeFileSync(f.attempt.output, JSON.stringify({ type: 'thread.started', thread_id: 'same-session' }) + '\n'
    + JSON.stringify({ type: 'turn.failed', error: { message: 'Selected model is at capacity' } }) + '\n');
  await f.settle();
  expect(f.ledger().tasks[f.task.id]!.attempts[1]?.continuedFor).toBe('capacity');
});

test('capacity attempts between progress endings do not grant another handoff continuation', async () => {
  const f = fixture();
  const ledger = f.ledger();
  const task = ledger.tasks[f.task.id]!;
  task.attempts.push({ ...f.attempt, n: 2, round: 'continuation', continuedFor: 'handoff' },
    { ...f.attempt, n: 3, round: 'continuation', continuedFor: 'capacity' });
  f.save(ledger);
  await f.settle();
  expect(f.ledger().tasks[f.task.id]!.attempts).toHaveLength(3);
  expect(f.events()).toEqual([{ key: 'task:G-001:3', body: 'RESULT: missing' }]);
});

test('a handoff between progress endings restores the one continuation allowance', async () => {
  const f = fixture();
  const ledger = f.ledger();
  const task = ledger.tasks[f.task.id]!;
  const handoff = join(f.directory, '.temp/partial.md');
  writeFileSync(handoff, 'RESULT: partial');
  task.attempts.push({ ...f.attempt, n: 2, lastMessage: handoff, round: 'continuation', continuedFor: 'handoff' },
    { ...f.attempt, n: 3, round: 'step' });
  f.save(ledger);
  await f.settle();
  expect(f.ledger().tasks[f.task.id]!.attempts[3]?.continuedFor).toBe('handoff');
});

test('measures count handoff continuations separately from first attempts and fixes', async () => {
  const f = fixture();
  const ledger = f.ledger();
  ledger.tasks[f.task.id]!.attempts.push({ ...f.attempt, n: 2, round: 'continuation', continuedFor: 'handoff' });
  const measures = (await goalMeasures(ledger, { root: f.directory, codexHomes: [] })).program!;
  expect(measures.attempts.run).toEqual({ first: 1, stepResume: 0, fixRound: 0, capacityRetry: 0, transportRetry: 0, handoffRetry: 1,
    jobWake: { passed: 0, assertion: 0, timeout: 0, environment: 0, harness: 0, unclassified: 0 },
    baselineRed: 0, environment: 0, unclassified: 0 });
  expect(measures.attempts.today).toEqual(measures.attempts.run);
  expect(measures.attempts.inferredFixRounds).toBe(0);
  expect(measures.firstAttemptShare.run).toEqual({ first: 1, attempts: 1, share: 1 });
  expect(measureLines('program', measures)[0]).toContain('1 handoff');
});
