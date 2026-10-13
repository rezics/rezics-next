import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REGENERATION_COMMIT_SUBJECT } from './ledger.ts';
import type { Attempt, Task } from './types.ts';
import { blockedAttemptAddedNothing, landingAttempt, landingMoved } from './tasks.ts';

const attempts = (...results: string[]): { task: Task; read: (attempt: Attempt) => { text: string; error: boolean } } => {
  const list = results.map((_, at) => ({ n: at + 1 }) as Attempt);
  return { task: { attempts: list } as Task,
    read: attempt => ({ text: `RESULT: ${results[attempt.n - 1]}\n`, error: results[attempt.n - 1] === 'error' }) };
};
const unchangedFrom = (first: number) => (_: Task, attempt: Attempt) => attempt.n >= first;

test('a blocked attempt that left the branch as it found it does not speak for the branch', () => {
  const inquiry = attempts('partial', 'partial', 'blocked');
  expect(landingAttempt(inquiry.task, inquiry.read, unchangedFrom(3)).n).toBe(2);
  const twice = attempts('done', 'blocked', 'blocked');
  expect(landingAttempt(twice.task, twice.read, unchangedFrom(2)).n).toBe(1);
});

test('a blocked attempt that changed the branch, and every other last handoff, is the one the landing reads', () => {
  const changed = attempts('partial', 'blocked');
  expect(landingAttempt(changed.task, changed.read, () => false).n).toBe(2);
  const done = attempts('partial', 'done');
  expect(landingAttempt(done.task, done.read, () => true).n).toBe(2);
  const failed = attempts('partial', 'error');
  expect(landingAttempt(failed.task, failed.read, () => true).n).toBe(2);
  const only = attempts('blocked');
  expect(landingAttempt(only.task, only.read, () => true).n).toBe(1);
});

test('review and merge hold the attempt the landing chose, whatever its rebase did to the branch', () => {
  const { task, read } = attempts('partial', 'blocked', 'blocked');
  const landing = { ...task, state: 'exited' } as Task, brief = () => 'brief';
  const snapshot = { attempt: 1, attempts: 3, handoff: read(task.attempts[0]!).text, brief: 'brief' };
  expect(landingMoved(landing, snapshot, read, brief)).toBe(false);
  expect(landingMoved({ ...landing, attempts: [...task.attempts, { n: 4 } as Attempt] } as Task, snapshot, read, brief)).toBe(true);
  expect(landingMoved(landing, { ...snapshot, handoff: 'another' }, read, brief)).toBe(true);
  expect(landingMoved(landing, snapshot, read, () => 'edited')).toBe(true);
  expect(landingMoved({ ...landing, state: 'running' } as Task, snapshot, read, brief)).toBe(true);
});

test('a blocked attempt added nothing although a landing has since rebased the branch and regenerated', () => {
  const repo = mkdtempSync(join(tmpdir(), 'landing-attempt-'));
  const run = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  const commit = (file: string, subject: string) => {
    writeFileSync(join(repo, file), subject); run('add', file); run('commit', '-qm', subject);
  };
  try {
    run('init', '-q', '-b', 'main');
    for (const [key, value] of [['user.email', 'goal@example.invalid'], ['user.name', 'goal'], ['commit.gpgsign', 'false']]) run('config', key!, value!);
    commit('base', 'base'); run('checkout', '-qb', 'task'); commit('work', 'work');
    const output = join(repo, '.git', 'attempt-2.json');
    writeFileSync(`${output}.head`, run('rev-parse', 'HEAD'));
    const task = { worktree: repo, base: run('rev-parse', 'main') } as Task, attempt = { n: 2, output } as Attempt;
    expect(blockedAttemptAddedNothing(task, attempt)).toBe(true);
    run('checkout', '-q', 'main'); commit('other', 'main moves'); run('checkout', '-q', 'task'); run('rebase', '-q', 'main');
    commit('generated', REGENERATION_COMMIT_SUBJECT);
    expect(blockedAttemptAddedNothing(task, attempt)).toBe(true);
    commit('more', 'more work');
    expect(blockedAttemptAddedNothing(task, attempt)).toBe(false);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});
