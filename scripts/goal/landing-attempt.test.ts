import { expect, test } from 'bun:test';
import type { Attempt, Task } from './types.ts';
import { landingAttempt, landingMoved } from './tasks.ts';

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

test('review and merge keep reading the attempt that made the branch after blocked inquiries follow it', () => {
  const { task, read } = attempts('partial', 'blocked', 'blocked');
  const landing = { ...task, state: 'exited' } as Task, brief = () => 'brief';
  const snapshot = { attempt: 1, handoff: read(task.attempts[0]!).text, brief: 'brief' };
  expect(landingMoved(landing, snapshot, read, unchangedFrom(2), brief)).toBe(false);
  expect(landingMoved(landing, snapshot, read, () => false, brief)).toBe(true);
  expect(landingMoved(landing, snapshot, read, unchangedFrom(2), () => 'edited')).toBe(true);
  expect(landingMoved({ ...landing, state: 'running' } as Task, snapshot, read, unchangedFrom(2), brief)).toBe(true);
});
