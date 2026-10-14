import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixtureSpawns } from './fixtures/spawn-deadline.ts';
import { parseBrief } from './briefs.ts';
import { resumeDecisionError } from './tasks.ts';
import type { Attempt, Ledger, Task } from './types.ts';

const spawn = fixtureSpawns(20_000);
const cli = join(import.meta.dir, 'goalctl.ts');

function repository() {
  const scratch = join(import.meta.dir, '../../.temp');
  mkdirSync(scratch, { recursive: true });
  const dir = mkdtempSync(join(scratch, 'idle-tasks-'));
  const git = (...args: string[]) => {
    const result = spawn('git', args, { cwd: dir, encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    return result.stdout.trim();
  };
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'goal@example.invalid');
  git('config', 'user.name', 'idle task fixture');
  writeFileSync(join(dir, '.gitignore'), '.temp/\n');
  git('add', '.');
  git('commit', '-qm', 'fixture');
  const state = join(dir, '.temp/goal-orchestration');
  mkdirSync(state, { recursive: true });
  const ledger: Ledger = { tasks: {}, goals: {
    alpha: { manager: 'fixture', startedAt: new Date().toISOString() },
    beta: { manager: 'fixture', startedAt: new Date().toISOString() },
  } };
  const task = (id: string, hours: number, goal = 'alpha'): Task => {
    const brief = join(state, `${id}.md`);
    writeFileSync(brief, `---\nid: ${id}\nkind: tooling\ntitle: Idle worker\nengine: codex\neffort: medium\npaths: [claimed.ts]\ntests: []\n---\n\n## Outcome\n\nRecover the worker.\n\n## Mechanisms\n\nnone\n`);
    const endedAt = new Date(Date.now() - hours * 3_600_000).toISOString();
    const value: Task = { ...parseBrief(readFileSync(brief, 'utf8')), brief, goal,
      worktree: dir, branch: 'main', base: git('rev-parse', 'HEAD'), state: 'exited', attempts: [{
        n: 1, engine: 'codex', effort: 'medium', pid: 0, session: '',
        output: join(state, `${id}.json`), lastMessage: join(state, `${id}.last.md`),
        startedAt: new Date(Date.parse(endedAt) - 3_600_000).toISOString(), endedAt, round: 'initial',
      }] };
    ledger.tasks[id] = value;
    return value;
  };
  const run = (goal: string, ...args: string[]) => {
    writeFileSync(join(state, 'ledger.json'), JSON.stringify(ledger));
    return spawn(process.execPath, [cli, ...args], { cwd: dir, encoding: 'utf8', env: {
      GOAL_ID: goal, GOAL_MAX_WORKERS: '5', GOAL_USAGE_FILE: join(state, 'usage.json'),
      GOAL_CODEX_HOME: join(state, 'codex'), GOAL_CODEX_1_HOME: join(state, 'codex-1'),
    } });
  };
  return { task, run, ledger, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

test('status names missing handoffs without replacing waiting or settlement reasons', () => {
  const repo = repository();
  try {
    repo.task('G-001', 7);
    writeFileSync(repo.ledger.tasks['G-001']!.attempts[0]!.output.replace('.json', '.err'), 'RESULT: partial\n');
    const malformed = repo.task('G-002', 6);
    writeFileSync(malformed.attempts[0]!.lastMessage!, 'I was still working.\n');
    const handedOff = repo.task('G-003', 5);
    writeFileSync(handedOff.attempts[0]!.lastMessage!, 'RESULT: partial\n');
    const waiting = repo.task('G-004', 4);
    waiting.waitingResume = { token: 'waiting', queuedAt: new Date().toISOString(),
      reason: 'Concurrency limit reached', message: 'Continue', fresh: true, forceUsage: false };
    const held = repo.task('G-005', 3);
    held.settlement = { attempt: 1, token: 'settled', owner: { pid: 0 },
      settledAt: new Date().toISOString(), reason: 'Held for manager review' };
    const grok = repo.task('G-006', 2);
    grok.attempts[0]!.engine = 'grok';
    delete grok.attempts[0]!.lastMessage;
    writeFileSync(grok.attempts[0]!.output, JSON.stringify({ result: 'Still working.' }));
    const grokHandoff = repo.task('G-007', 1);
    grokHandoff.attempts[0]!.engine = 'grok';
    delete grokHandoff.attempts[0]!.lastMessage;
    writeFileSync(grokHandoff.attempts[0]!.output, JSON.stringify({ result: 'RESULT: partial\n' }));
    const result = repo.run('alpha', 'status');
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.match(/attempt ended without a handoff/g)).toHaveLength(3);
    expect(result.stdout).toContain('attempt ended without a handoff 7h00m ago; resume G-001 --fresh -m <text>, or add --engine <engine>');
    expect(result.stdout).toContain('attempt ended without a handoff 6h00m ago; resume G-002');
    expect(result.stdout).toContain('resume waiting: Concurrency limit reached');
    expect(result.stdout).toContain('Held for manager review');
    expect(result.stdout).toContain('attempt ended without a handoff 2h00m ago; resume G-006');
  } finally { repo.dispose(); }
});

test('status summarizes the three oldest exits per Goal and free live places', () => {
  const repo = repository();
  try {
    for (const [id, hours] of [['G-001', 2], ['G-002', 7], ['G-003', 4], ['G-004', 6]] as const) repo.task(id, hours);
    repo.task('G-005', 3, 'beta');
    repo.task('G-006', 0, 'beta').state = 'starting';
    const summary = 'Goal alpha: 4 exited; longest exited: G-002 7h00m, G-004 6h00m, G-003 4h00m; 4 live worker places free';
    const scoped = repo.run('alpha', 'status');
    expect(scoped.status, scoped.stderr).toBe(0);
    expect(scoped.stdout).toContain(summary);
    expect(scoped.stdout).not.toContain('Goal beta: 1 exited;');
    const program = repo.run('program', 'status');
    expect(program.status, program.stderr).toBe(0);
    expect(program.stdout).toContain(summary);
    expect(program.stdout).toContain('Goal beta: 1 exited; longest exited: G-005 3h00m; 4 live worker places free');
    for (const value of Object.values(repo.ledger.tasks)) value.state = 'stopped';
    const empty = repo.run('program', 'status');
    expect(empty.status, empty.stderr).toBe(0);
    expect(empty.stdout).not.toContain('longest exited:');
  } finally { repo.dispose(); }
});

test('land refuses a task stop with the reclaim then merge remedy', () => {
  const repo = repository();
  try {
    const task = repo.task('G-001', 2);
    task.state = 'conflict';
    task.mergeStop = { kind: 'task', landing: true, message: 'Changed files fall outside the brief' };
    const result = repo.run('alpha', 'land', task.id);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('land requires an exited task (conflict)');
    expect(result.stderr).toContain(task.mergeStop.message);
    expect(result.stderr).toContain('Correct the brief, reclaim G-001 <brief>, then merge G-001.');
  } finally { repo.dispose(); }
});

test('resume after two fixes uses the last Decision and quotes its heading on refusal', () => {
  const repo = repository();
  try {
    const task = repo.task('G-001', 2);
    const initial = task.attempts[0]!;
    task.attempts.push(...[2, 3].map(n => ({ ...initial, n, round: 'fix' as const,
      startedAt: '2026-10-14T00:30:00Z' })));
    writeFileSync(task.brief, readFileSync(task.brief, 'utf8')
      + '\n## Decision — 2026-10-14 00:40 UTC: split\nEarlier approval.\n\n## Decision — 2026-10-14 00:20 UTC: cut\nOld decision.\n');
    const result = repo.run('alpha', 'resume', task.id, '--fresh', '-m', 'Continue');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('two fix rounds exhausted');
    expect(result.stderr).toContain('looked at "## Decision — 2026-10-14 00:20 UTC: cut"');
  } finally { repo.dispose(); }
});

test('Decision dates and remedies may be in the heading or body', () => {
  const attempts = [1, 2, 3].map(n => ({ n, startedAt: '2026-10-14T00:30:00Z' })) as Attempt[];
  for (const word of ['cut', 'split', 'design note']) {
    for (const section of [
      `## Decision — 2026-10-14 00:40 UTC: ${word}\nProceed.\n`,
      `## Decision\n2026-10-14 00:40 UTC: ${word}\n`,
      `## Decision — ${word}\n2026-10-14T00:40:00Z\n`,
      `## Decision — 2026-10-14 00:40 UTC\n${word}\n`,
      `## Decision — 2026-10-14 00:40 UTC: ${word}`,
    ]) expect(resumeDecisionError(attempts, section)).toBeUndefined();
  }
  expect(resumeDecisionError(attempts, '## Decision\n2026-10-14 00:40 UTC: split\n\n## Decision\nNo decision yet.\n'))
    .toContain('looked at "## Decision"');
  expect(resumeDecisionError(attempts, '## Decision\n2026-10-14 00:40 UTC: split\n\n## Decision — pending'))
    .toContain('looked at "## Decision — pending"');
  expect(resumeDecisionError(attempts, '## Decision\n2026-10-14 00:40 UTC\n\n## Other\nsplit\n')).toBeDefined();
});
