import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Ledger, Task } from './types.ts';
import { GoalMailStore } from './mail.ts';
import { GoalCoordinator, type IndependentLauncher, processIdentity, WAKE_PROMPT, WAKE_LAST_MESSAGE } from './coordinator.ts';
import { managerEvents } from './manager-commands.ts';
import { classifyLandingRefusal } from './refusal.ts';

const scratch = join(import.meta.dir, '../../.temp/settlement-tests');
const fixtures: { directory: string; task: Task; ledger: () => Ledger }[] = [];

function fixture(result = 'done', kind: Task['kind'] = 'tooling') {
  mkdirSync(scratch, { recursive: true });
  const directory = mkdtempSync(join(scratch, 'case-'));
  const state = join(directory, '.temp/goal-orchestration');
  const run = join(state, 'runs/G-001');
  mkdirSync(run, { recursive: true });
  const git = (...args: string[]) => {
    const child = spawnSync('git', args, { cwd: directory, encoding: 'utf8' });
    if (child.status !== 0) throw new Error(child.stderr);
    return child.stdout.trim();
  };
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Settlement fixture');
  git('config', 'user.email', 'settlement@example.invalid');
  mkdirSync(join(directory, 'scripts/goal'), { recursive: true });
  for (const file of ['dedupe-imports.ts', 'composition-roots.ts']) copyFileSync(join(import.meta.dir, file), join(directory, 'scripts/goal', file));
  writeFileSync(join(directory, '.gitignore'), '.temp/\n');
  writeFileSync(join(directory, 'README.md'), 'Fixture\n');
  git('add', '.'); git('commit', '-qm', 'Initial fixture');
  const base = git('rev-parse', 'HEAD');
  const worktree = join(directory, '.temp/tree');
  git('worktree', 'add', '-qb', 'goal/fixture', worktree);
  const brief = join(directory, '.temp/brief.md');
  writeFileSync(brief, `---\nid: G-001\nkind: ${kind}\ntitle: Deliver a file\neffort: high\npaths: [delivered.txt]\n---\n`);
  const output = join(run, 'attempt.json');
  writeFileSync(output, JSON.stringify({ result: `RESULT: ${result}\nNEXT: Inspect the remaining work`, is_error: false }));
  const task: Task = { id: 'G-001', title: 'Deliver a file', kind, effort: 'high', cases: [], paths: ['delivered.txt'],
    migrations: [], shared: [], depends: [], brief, worktree, branch: 'goal/fixture', base, state: 'running', goal: 'program',
    attempts: [{ n: 1, engine: 'claude', effort: 'high', pid: 2147483647, session: 'fixture', output,
      startedAt: new Date().toISOString() }] };
  const ledgerPath = join(state, 'ledger.json');
  const save = (ledger: Ledger) => writeFileSync(ledgerPath, JSON.stringify(ledger));
  save({ tasks: { [task.id]: task }, goals: { program: { manager: 'fixture-manager', startedAt: new Date().toISOString() } } });
  const bin = join(directory, '.temp/bin');
  mkdirSync(bin);
  const release = join(directory, '.temp/release');
  const gate = join(directory, '.temp/gate');
  const launches = join(directory, '.temp/launches.jsonl');
  const workerRelease = join(directory, '.temp/worker-release');
  writeFileSync(join(bin, 'claude'), `#!/usr/bin/env bun
    import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
    const args = process.argv.slice(2);
    appendFileSync(${JSON.stringify(launches)}, JSON.stringify(args) + '\\n');
    while (!existsSync(${JSON.stringify(workerRelease)})) await Bun.sleep(10);
    writeFileSync('delivered.txt', 'Fixed\\n');
    const committed = Bun.spawnSync(['git', 'commit', '-qam', 'Fix delivered file']);
    if (committed.exitCode !== 0) process.exit(committed.exitCode);
    console.log(JSON.stringify({ result: 'RESULT: done', session_id: 'fixture', is_error: false }));
  `);
  chmodSync(join(bin, 'claude'), 0o755);
  writeFileSync(join(bin, 'task'), `#!/usr/bin/env bun
    import { existsSync, writeFileSync } from 'node:fs';
    const args = process.argv.slice(2);
    if (args.includes('--list')) {
      writeFileSync(${JSON.stringify(gate)}, 'running');
      while (!existsSync(${JSON.stringify(release)})) await Bun.sleep(10);
      console.log('Affected since HEAD: fixture');
    }
  `);
  writeFileSync(join(bin, 'docker'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(bin, 'task'), 0o755); chmodSync(join(bin, 'docker'), 0o755);
  mkdirSync(join(run, 'review-000'));
  // A retained completed review exercises settlement and the real landing/gate owners without a model call.
  writeFileSync(join(run, 'review-000/findings.json'), JSON.stringify({ findings: [] }));
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, GOAL_ID: 'program', GOAL_MEMORY_FLOOR_GIB: '0',
    GOAL_MAX_WORKERS: '25', GOAL_CODEX_HOME: join(directory, '.temp/codex'), GOAL_MEMINFO_FILE: join(directory, '.temp/meminfo'),
    GOAL_USAGE_FILE: join(directory, '.temp/usage.json'), GOAL_UNIT_GATE_SCOPE: 'affected', GOAL_GATE_LANES: '25' };
  writeFileSync(env.GOAL_MEMINFO_FILE, 'MemAvailable: 67108864 kB\n');
  const execute = async (args: string[], source = false) => {
    const child = Bun.spawn([process.execPath, ...source ? ['-e', args[0]!] : [join(import.meta.dir, 'goalctl.ts'), ...args]],
      { cwd: directory, env, stdout: 'pipe', stderr: 'pipe' });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, stderr).toBe(0);
    return stdout;
  };
  const current = { directory, state, run, task, output, release, gate, env, git, save, execute, launches, workerRelease,
    ledger: () => JSON.parse(readFileSync(ledgerPath, 'utf8')) as Ledger,
    commit: () => {
      writeFileSync(join(worktree, 'delivered.txt'), 'Delivered\n');
      git('-C', worktree, 'add', 'delivered.txt'); git('-C', worktree, 'commit', '-qm', 'Deliver file');
    } };
  fixtures.push(current);
  return current;
}

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('Settlement fixture timed out');
    await Bun.sleep(20);
  }
}

afterEach(() => {
  for (const f of fixtures.splice(0)) {
    for (const attempt of f.ledger().tasks[f.task.id]?.attempts ?? []) {
      if (attempt.pid && attempt.pid !== 2147483647) { try { process.kill(attempt.pid, 'SIGKILL'); } catch { /* exited */ } }
    }
    const owner = f.ledger().tasks[f.task.id]?.settlement?.owner;
    if (owner && owner.pid !== process.pid) { try { process.kill(owner.pid, 'SIGKILL'); } catch { /* exited */ } }
    rmSync(f.directory, { recursive: true, force: true });
  }
});

function stoppedLanding(f: ReturnType<typeof fixture>, refusal: string, automatic = true) {
  const directory = join(f.run, 'review-001');
  mkdirSync(directory);
  writeFileSync(join(directory, 'stop.txt'), refusal);
  const ledger = f.ledger();
  const task = ledger.tasks[f.task.id]!;
  task.state = 'conflict'; task.refusal = refusal.split('\n')[0];
  task.settlement = { attempt: 1, token: 'dead-owner', owner: { pid: 2147483646 } };
  f.save(ledger);
  if (automatic) writeFileSync(join(f.run, 'settle-1.json'), JSON.stringify({ reportsBefore: ['review-000'],
    brief: readFileSync(f.task.brief, 'utf8'), branch: f.task.branch, worktree: f.task.worktree,
    handoff: JSON.parse(readFileSync(f.output, 'utf8')).result }));
  return directory;
}

test('a unit-gate refusal resumes its own session with only bounded failure evidence, then lands the fix', async () => {
  const f = fixture(); f.commit();
  stoppedLanding(f, `${f.task.id} introduced unit failures; not merging:\n  value.test.ts\n    (fail) delivery is fixed\n      error: Expected fixed delivery`);
  writeFileSync(f.release, 'release');
  await f.execute(['settle']);
  await until(() => {
    const settlement = f.ledger().tasks[f.task.id]!.settlement;
    if (settlement?.settledAt) throw new Error(`${settlement.reason}\n${readFileSync(join(f.run, 'settle.log'), 'utf8')}`);
    return existsSync(f.launches);
  });
  const current = f.ledger().tasks[f.task.id]!;
  expect(current.attempts).toHaveLength(2);
  expect(current.attempts[1]!.round).toBe('fix');
  expect(current.attempts[1]!.session).toBe('fixture');
  const args = JSON.parse(readFileSync(f.launches, 'utf8').trim()) as string[];
  expect(args).toContain('--resume');
  const message = args.at(-1)!;
  expect(message).toContain('Check: unit gate');
  expect(message).toContain('(fail) delivery is fixed');
  expect(message).toContain('Expected fixed delivery');
  expect(message).not.toContain('pass');
  expect(message.split('\n').length).toBeLessThanOrEqual(60);
  expect(existsSync(message.split('Whole output: ')[1]!)).toBe(true);
  expect(await f.execute(['status'])).toContain('fix round sent by tool for unit gate');
  const mail = new GoalMailStore({ stateDir: f.state, goals: ['program'] });
  try { expect(managerEvents(f.state, 'program', mail)).toEqual([]); } finally { mail.close(); }
  writeFileSync(f.workerRelease, 'fix');
  await until(() => existsSync(join(f.run, 'attempt-2.json')) && readFileSync(join(f.run, 'attempt-2.json'), 'utf8').includes('RESULT: done'));
  await f.execute(['settle']);
  await until(() => f.ledger().tasks[f.task.id]!.state === 'verified');
  expect(readFileSync(join(f.directory, 'delivered.txt'), 'utf8')).toBe('Fixed\n');
}, 60_000);

test.each([
  'changed files outside its claim:',
  'out-of-claim files are claimed by another task:',
  'review test paths claimed by another task:',
  'task or brief changed during review',
  'scope changed during review; review again',
  'review is stale: task branch changed after review; not merging',
  'git rebase main failed:',
  'dependency has not landed',
  'type check inconclusive; not merging:',
  'unit gate remains inconclusive after isolated timeout retry:',
  'an unknown refusal',
])('a manager keeps the recorded reason: %s', async refusal => {
  const f = fixture(); stoppedLanding(f, refusal);
  await f.execute(['settle']);
  await until(() => !!f.ledger().tasks[f.task.id]!.settlement?.settledAt);
  expect(f.ledger().tasks[f.task.id]!.settlement?.reason).toBe(refusal);
  expect(f.ledger().tasks[f.task.id]!.attempts).toHaveLength(1);
  expect(existsSync(f.launches)).toBe(false);
});

test.each([
  ['pre-merge type check', 'introduced type errors; not merging:\n  scripts: value.ts: error TS2322: Wrong type'],
  ['repository guard (unit gate)', 'introduced unit failures; not merging:\n  scripts/static/anti-silo.test.ts\n    (fail) one owner\n      error: duplicate owner'],
])('a restarted pass sends the recorded %s failure once', async (check, refusal) => {
  const f = fixture(); stoppedLanding(f, `${f.task.id} ${refusal}`);
  await Promise.all([f.execute(['settle']), f.execute(['settle'])]);
  await until(() => existsSync(f.launches));
  await f.execute(['settle']);
  expect(f.ledger().tasks[f.task.id]!.attempts).toHaveLength(2);
  expect(readFileSync(f.launches, 'utf8').trim().split('\n')).toHaveLength(1);
  const args = JSON.parse(readFileSync(f.launches, 'utf8').trim()) as string[];
  expect(args.at(-1)).toContain(`Check: ${check}`);
});

test('a review refusal left exited is returned after a restart, without landing it again', async () => {
  const f = fixture();
  stoppedLanding(f, `${f.task.id} introduced unit failures; not merging:\n  value.test.ts\n    (fail) delivery`);
  const ledger = f.ledger(); ledger.tasks[f.task.id]!.state = 'exited'; f.save(ledger);
  await f.execute(['settle']); await until(() => existsSync(f.launches));
  expect(f.ledger().tasks[f.task.id]!.attempts).toHaveLength(2);
  expect(existsSync(f.gate)).toBe(false);
});

test.each(['exited', 'conflict'] as const)('a landing a manager started never sends a fix round from %s', async state => {
  const f = fixture();
  stoppedLanding(f, `${f.task.id} introduced unit failures; not merging:\n  value.test.ts\n    (fail) delivery`, false);
  const ledger = f.ledger(); ledger.tasks[f.task.id]!.state = state; f.save(ledger);
  await f.execute(['settle']);
  await until(() => !!f.ledger().tasks[f.task.id]!.settlement?.settledAt);
  expect(f.ledger().tasks[f.task.id]!.attempts).toHaveLength(1);
  expect(existsSync(f.launches)).toBe(false);
});

test.each(['brief', 'handoff', 'branch'] as const)('a %s change after the refusal keeps it with the manager', async change => {
  const f = fixture();
  stoppedLanding(f, `${f.task.id} introduced unit failures; not merging:\n  value.test.ts\n    (fail) delivery`);
  if (change === 'brief') writeFileSync(f.task.brief, readFileSync(f.task.brief, 'utf8') + '\nChanged outcome.\n');
  if (change === 'handoff') writeFileSync(f.output, JSON.stringify({ result: 'RESULT: done\nNEXT: A changed handoff', is_error: false }));
  if (change === 'branch') { const ledger = f.ledger(); ledger.tasks[f.task.id]!.branch = 'goal/changed'; f.save(ledger); }
  await f.execute(['settle']);
  await until(() => !!f.ledger().tasks[f.task.id]!.settlement?.settledAt);
  expect(f.ledger().tasks[f.task.id]!.settlement?.reason).toBe('task or brief changed after landing stopped');
  expect(f.ledger().tasks[f.task.id]!.attempts).toHaveLength(1);
  expect(existsSync(f.launches)).toBe(false);
});

test('the resume cap settles the last failure for the manager without changing the brief', async () => {
  const f = fixture(); stoppedLanding(f, `${f.task.id} introduced unit failures; not merging:\n  value.test.ts\n    (fail) delivery\n      error: Expected fixed`);
  const ledger = f.ledger();
  const task = ledger.tasks[f.task.id]!;
  task.attempts.push({ ...task.attempts[0]!, n: 2, round: 'fix' }, { ...task.attempts[0]!, n: 3, round: 'fix' });
  task.settlement!.attempt = 3;
  f.save(ledger);
  copyFileSync(join(f.run, 'settle-1.json'), join(f.run, 'settle-3.json'));
  const brief = readFileSync(f.task.brief, 'utf8');
  await f.execute(['settle']);
  await until(() => !!f.ledger().tasks[f.task.id]!.settlement?.settledAt);
  const settled = f.ledger().tasks[f.task.id]!;
  expect(settled.attempts).toHaveLength(3);
  expect(settled.settlement?.reason).toContain('two fix rounds exhausted');
  expect(settled.settlement?.reason).toContain('(fail) delivery');
  expect(readFileSync(f.task.brief, 'utf8')).toBe(brief);
  expect(existsSync(f.launches)).toBe(false);
  const mail = new GoalMailStore({ stateDir: f.state, goals: ['program'] });
  try { expect(managerEvents(f.state, 'program', mail)).toEqual([{ key: `task:${f.task.id}:3`, body: settled.settlement!.reason! }]); }
  finally { mail.close(); }
});

test('review findings return only reproduced failing cases and their first error lines', async () => {
  const f = fixture();
  const directory = stoppedLanding(f, 'blocking review tests committed for the fix:\n  tests/qa/integration/review/delivery.test.ts');
  const artifact = join(directory, 'artifacts'); mkdirSync(artifact);
  writeFileSync(join(directory, 'test-result.json'), JSON.stringify({ artifactPaths: [artifact] }));
  writeFileSync(join(artifact, 'acceptance.json'), JSON.stringify({ sourceStable: true, tests: [
    { file: 'tests/qa/integration/review/delivery.test.ts', name: 'reader gets delivery', failed: true, skipped: false,
      detail: 'Expected: delivered\nReceived: missing\nerror: assertion\nstack detail' },
    { file: 'tests/qa/integration/review/delivery.test.ts', name: 'a passing case', failed: false, skipped: false },
  ] }));
  await f.execute(['settle']); await until(() => existsSync(f.launches));
  const args = JSON.parse(readFileSync(f.launches, 'utf8').trim()) as string[];
  expect(args.at(-1)).toContain('Check: review finding with a failing test');
  expect(args.at(-1)).toContain('reader gets delivery');
  expect(args.at(-1)).toContain('Received: missing');
  expect(args.at(-1)).not.toContain('stack detail');
  expect(args.at(-1)).not.toContain('a passing case');
});

test.each(['missing', 'unstable', 'timeout', 'preparation'] as const)('an unproved review refusal stays with the manager: %s', async evidence => {
  const f = fixture();
  const directory = stoppedLanding(f, 'committed review tests did not pass');
  if (evidence !== 'missing') {
    const artifact = join(directory, 'artifacts'); mkdirSync(artifact);
    writeFileSync(join(directory, 'test-result.json'), JSON.stringify({ artifactPaths: [artifact] }));
    writeFileSync(join(artifact, 'acceptance.json'), JSON.stringify({ sourceStable: evidence !== 'unstable', tests: [
      { file: 'tests/qa/integration/review/delivery.test.ts', name: 'reader gets delivery', failed: true, skipped: false,
        detail: 'Expected: delivered', timeout: evidence === 'timeout', preparationFailure: evidence === 'preparation' },
    ] }));
  }
  await f.execute(['settle']);
  await until(() => !!f.ledger().tasks[f.task.id]!.settlement?.settledAt);
  expect(f.ledger().tasks[f.task.id]!.settlement?.reason).toBe('committed review tests did not pass');
  expect(existsSync(f.launches)).toBe(false);
});

test('failure messages stay within sixty lines and omit inherited failures and later error lines', () => {
  const f = fixture();
  const directory = stoppedLanding(f, `${f.task.id} introduced unit failures; not merging:\n`
    + Array.from({ length: 30 }, (_, n) => `  value.test.ts\n    (fail) case ${n}\n      error: first\n      second\n      third\n      fourth`).join('\n')
    + '\ninherited on main:\n  inherited.test.ts\n    (fail) inherited case');
  const refusal = classifyLandingRefusal(join(directory, 'stop.txt'));
  expect(refusal.kind).toBe('worker');
  if (refusal.kind !== 'worker') throw new Error('Expected worker refusal');
  expect(refusal.message.split('\n')).toHaveLength(60);
  expect(refusal.message).not.toContain('fourth');
  expect(refusal.message).not.toContain('inherited');
});

test('one pass lands and closes a done tooling task, without a waiter or an enrolled manager', async () => {
  const f = fixture(); f.commit(); writeFileSync(f.release, 'release');
  await f.execute(['settle']);
  await until(() => !!f.ledger().tasks[f.task.id]!.settlement?.settledAt);
  const task = f.ledger().tasks[f.task.id]!;
  expect(task.state, task.settlement?.reason).toBe('verified');
  expect(task.settlement?.reason).toBe('landed and verified');
  expect(readFileSync(join(f.directory, 'delivered.txt'), 'utf8')).toBe('Delivered\n');
  expect(existsSync(f.task.worktree)).toBe(false);
}, 45_000);

test('partial handoff stays open, its result and NEXT become one durable manager event', async () => {
  const f = fixture('partial');
  await f.execute(['settle']);
  await until(() => !!f.ledger().tasks[f.task.id]!.settlement?.settledAt);
  expect(f.ledger().tasks[f.task.id]!.state).toBe('exited');
  const mail = new GoalMailStore({ stateDir: f.state, goals: ['program'] });
  const launches: string[] = [];
  const launcher: IndependentLauncher = { verify() {}, live: () => true, launch: token => { launches.push(token); } };
  const coordinator = new GoalCoordinator({ stateDir: f.state, launcher, admit: () => {}, owner: () => undefined,
    events: goal => managerEvents(f.state, goal, mail) });
  try {
    const event = managerEvents(f.state, 'program', mail);
    expect(event).toEqual([{ key: `task:${f.task.id}:1`, body: 'RESULT: partial; NEXT: Inspect the remaining work' }]);
    coordinator.enroll({ goal: 'program', generation: 'fixture', session: 'fixture', engine: 'codex', effort: 'high',
      cwd: f.directory, home: f.directory, program: process.execPath, args: [WAKE_PROMPT, WAKE_LAST_MESSAGE], env: {}, socket: 'unused',
      server: processIdentity(process.pid)!, previousOwner: { ...processIdentity(process.pid)!, start: 'dead' } });
    coordinator.step(); coordinator.step();
    expect(launches).toHaveLength(1);
    expect(coordinator.db.query("SELECT COUNT(*) AS n FROM events WHERE event_key LIKE 'task:%'").get()).toEqual({ n: 1 });
    await f.execute(['settle']);
    expect(f.ledger().tasks[f.task.id]!.settlement?.reason).toBe(event[0]!.body);
  } finally { coordinator.close(); mail.close(); }
});

test('landing refusal is settled once and preserves its first line', async () => {
  const f = fixture();
  writeFileSync(join(f.task.worktree, 'delivered.txt'), 'Dirty\n');
  await f.execute(['settle']);
  await until(() => !!f.ledger().tasks[f.task.id]!.settlement?.settledAt);
  const first = f.ledger().tasks[f.task.id]!.settlement!;
  expect(first.reason).toBe(`${f.task.id}: land requires a clean worktree`);
  expect(f.ledger().tasks[f.task.id]!.state).toBe('exited');
  await f.execute(['settle']);
  expect(f.ledger().tasks[f.task.id]!.settlement).toEqual(first);
});

test('concurrent passes, a restarted pump, and a waiter observe the same landing', async () => {
  const f = fixture(); f.commit();
  await Promise.all([f.execute(['settle']), f.execute(['settle'])]);
  await until(() => existsSync(f.gate) || !!f.ledger().tasks[f.task.id]!.settlement?.settledAt);
  expect(existsSync(f.gate), f.ledger().tasks[f.task.id]!.settlement?.reason).toBe(true);
  const original = f.ledger().tasks[f.task.id]!.settlement!;
  const mail = new GoalMailStore({ stateDir: f.state, goals: ['program'] });
  try { expect(managerEvents(f.state, 'program', mail)).toEqual([]); } finally { mail.close(); }
  // A new process has no memory of the earlier pass, only its durable child identity.
  await f.execute(['coordinator', '--once']);
  expect(f.ledger().tasks[f.task.id]!.settlement?.token).toBe(original.token);
  const wait = f.execute([`import { waitFor } from ${JSON.stringify(join(import.meta.dir, 'tasks.ts'))};
    await waitFor('${f.task.id}', { pollMs: 10, settleMs: 1 });`], true);
  writeFileSync(f.release, 'release');
  const output = await wait;
  expect(output).toContain('--- handoff ---\nRESULT: done');
  expect(output).toContain('attempt 1 ended');
  expect(f.ledger().tasks[f.task.id]!.state).toBe('verified');
  expect(f.ledger().tasks[f.task.id]!.settlement?.token).toBe(original.token);
  expect(readFileSync(join(f.state, 'merges.jsonl'), 'utf8').trim().split('\n')).toHaveLength(1);
}, 45_000);

test('a dead settlement owner can be reclaimed after a crash, with one new claim', async () => {
  const f = fixture('partial');
  const ledger = f.ledger();
  ledger.tasks[f.task.id]!.settlement = { attempt: 1, token: 'dead-owner', owner: { pid: 2147483646 } };
  f.save(ledger);
  await Promise.all([f.execute(['settle']), f.execute(['settle'])]);
  await until(() => !!f.ledger().tasks[f.task.id]!.settlement?.settledAt);
  expect(f.ledger().tasks[f.task.id]!.settlement?.token).not.toBe('dead-owner');
  expect(f.ledger().tasks[f.task.id]!.settlement?.reason).toContain('RESULT: partial');
});

test('wait can settle an unclaimed exit and a later pass leaves its claim alone', async () => {
  const f = fixture('partial');
  const output = await f.execute([`import { waitFor } from ${JSON.stringify(join(import.meta.dir, 'tasks.ts'))};
    await waitFor('${f.task.id}', { pollMs: 1, settleMs: 1 });`], true);
  expect(output).toContain('--- handoff ---\nRESULT: partial');
  const settlement = f.ledger().tasks[f.task.id]!.settlement!;
  await f.execute(['settle']);
  expect(f.ledger().tasks[f.task.id]!.settlement).toEqual(settlement);
});

test('a read-only final step after a merged step closes verified despite its path claims', async () => {
  const f = fixture(); f.commit();
  f.git('merge', '--ff-only', 'goal/fixture');
  const ledger = f.ledger(); ledger.tasks[f.task.id]!.mergedCommit = f.git('rev-parse', 'HEAD'); f.save(ledger);
  await f.execute(['settle']);
  await until(() => !!f.ledger().tasks[f.task.id]!.settlement?.settledAt);
  expect(f.ledger().tasks[f.task.id]!.state).toBe('verified');
});

test('a missing worktree cannot make unlanded commits look like a read-only final step', async () => {
  const f = fixture(); f.commit();
  f.git('merge', '--ff-only', 'goal/fixture');
  const ledger = f.ledger(); ledger.tasks[f.task.id]!.mergedCommit = f.git('rev-parse', 'HEAD'); f.save(ledger);
  writeFileSync(join(f.task.worktree, 'delivered.txt'), 'Further work\n');
  f.git('-C', f.task.worktree, 'commit', '-qam', 'Further work');
  f.git('worktree', 'remove', f.task.worktree);
  await f.execute(['settle']);
  await until(() => !!f.ledger().tasks[f.task.id]!.settlement?.settledAt);
  expect(f.ledger().tasks[f.task.id]!.state).toBe('exited');
  expect(f.ledger().tasks[f.task.id]!.settlement?.reason).not.toBe('landed and verified');
});

test('cancelling a read-only final step still keeps its task branch', async () => {
  const f = fixture(); f.commit(); f.git('merge', '--ff-only', 'goal/fixture');
  const ledger = f.ledger();
  ledger.tasks[f.task.id]!.state = 'exited'; ledger.tasks[f.task.id]!.mergedCommit = f.git('rev-parse', 'HEAD'); f.save(ledger);
  await f.execute(['close', f.task.id, 'cancelled']);
  expect(f.ledger().tasks[f.task.id]!.state).toBe('cancelled');
  expect(f.git('rev-parse', '--verify', 'goal/fixture')).toBe(f.git('rev-parse', 'HEAD'));
});

test('a partial merged step stays open until its final done handoff', async () => {
  const f = fixture('partial'); f.commit();
  f.git('merge', '--ff-only', 'goal/fixture');
  const ledger = f.ledger();
  ledger.tasks[f.task.id]!.state = 'merged'; ledger.tasks[f.task.id]!.mergedCommit = f.git('rev-parse', 'HEAD'); f.save(ledger);
  await f.execute(['settle']);
  await until(() => !!f.ledger().tasks[f.task.id]!.settlement?.settledAt);
  expect(f.ledger().tasks[f.task.id]!.state).toBe('merged');
  expect(f.ledger().tasks[f.task.id]!.settlement?.reason).toContain('RESULT: partial');
  const mail = new GoalMailStore({ stateDir: f.state, goals: ['program'] });
  try { expect(managerEvents(f.state, 'program', mail)[0]?.body).toContain('RESULT: partial'); } finally { mail.close(); }
});

test('an implementation opted into auto landing closes without a manager call', async () => {
  const f = fixture('done', 'implementation'); f.commit(); writeFileSync(f.release, 'release');
  const ledger = f.ledger(); ledger.tasks[f.task.id]!.land = 'auto'; f.save(ledger);
  await f.execute(['settle']);
  await until(() => !!f.ledger().tasks[f.task.id]!.settlement?.settledAt);
  expect(f.ledger().tasks[f.task.id]!.state, f.ledger().tasks[f.task.id]!.settlement?.reason).toBe('verified');
}, 45_000);

test('a transport drop continues in a fresh session and preserves dirty work', async () => {
  const f = fixture();
  const ledger = f.ledger(); ledger.tasks[f.task.id]!.attempts[0]!.engine = 'codex'; f.save(ledger);
  writeFileSync(f.output, '');
  writeFileSync(f.output.replace(/\.json$/, '.err'), 'RetriableError: [internal] HTTP/2 keepalive ping timed out after 5000ms\n');
  writeFileSync(join(f.task.worktree, 'delivered.txt'), 'Uncommitted progress\n');
  const worker = join(f.directory, '.temp/bin/codex');
  writeFileSync(worker, '#!/usr/bin/env bun\nawait Bun.sleep(30000);\n'); chmodSync(worker, 0o755);
  await f.execute(['settle']);
  await until(() => f.ledger().tasks[f.task.id]!.attempts.length === 2);
  const task = f.ledger().tasks[f.task.id]!;
  expect(task.state).toBe('running');
  expect(task.attempts[1]!.continuedFor).toBe('transport');
  expect(task.attempts[1]!.session).toBe('');
  expect(readFileSync(join(task.worktree, 'delivered.txt'), 'utf8')).toBe('Uncommitted progress\n');
  try { process.kill(task.attempts[1]!.pid, 'SIGKILL'); } catch { /* exited */ }
});

for (const kind of ['implementation', 'mechanism'] as const) {
  test(`${kind} needs an explicit auto landing decision`, async () => {
    const f = fixture('done', kind);
    await f.execute(['settle']);
    await until(() => !!f.ledger().tasks[f.task.id]!.settlement?.settledAt);
    expect(f.ledger().tasks[f.task.id]!.state).toBe('exited');
    expect(f.ledger().tasks[f.task.id]!.settlement?.reason).toContain('land: auto is absent');
  });
}

test('a capacity refusal continues the same session and makes no manager event', async () => {
  const f = fixture();
  const ledger = f.ledger(); ledger.tasks[f.task.id]!.attempts[0]!.engine = 'codex';
  ledger.tasks[f.task.id]!.attempts[0]!.session = ''; f.save(ledger);
  writeFileSync(f.output, '{"type":"thread.started","thread_id":"capacity-session"}\n{"type":"turn.failed","error":{"message":"at capacity"}}\n');
  const worker = join(f.directory, '.temp/bin/codex');
  writeFileSync(worker, '#!/usr/bin/env bun\nawait Bun.sleep(30000);\n'); chmodSync(worker, 0o755);
  // Execute the pass with a detached child using the same settlement entry point and a short capacity pause.
  await f.execute([`import { settlePass } from ${JSON.stringify(join(import.meta.dir, 'settle.ts'))};
    import { spawn } from 'node:child_process';
    import { processIdentity } from ${JSON.stringify(join(import.meta.dir, '../qa/process/identity.ts'))};
    await settlePass({ spawn: (task, token) => {
      const source = 'import { runSettlement } from ' + ${JSON.stringify(JSON.stringify(join(import.meta.dir, 'settle.ts')))}
        + '; await runSettlement(' + JSON.stringify(task.id) + ', 1, ' + JSON.stringify(token) + ', { capacityWaitMs: 1 });';
      const child = spawn(process.execPath, ['-e', source], { detached: true, stdio: 'ignore' });
      child.unref(); return processIdentity(child.pid) ?? { pid: child.pid };
    }});`], true);
  await until(() => f.ledger().tasks[f.task.id]!.attempts.length === 2);
  const task = f.ledger().tasks[f.task.id]!;
  expect(task.state).toBe('running');
  expect(task.attempts[1]!.continuedFor).toBe('capacity');
  expect(task.attempts[1]!.session).toBe('capacity-session');
  try { process.kill(task.attempts[1]!.pid, 'SIGKILL'); } catch { /* exited */ }
  const mail = new GoalMailStore({ stateDir: f.state, goals: ['program'] });
  try { expect(managerEvents(f.state, 'program', mail)).toEqual([]); } finally { mail.close(); }
});
