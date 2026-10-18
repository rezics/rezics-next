import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import type { QueueLedger } from './queue.ts';
import type { Attempt, Task } from './types.ts';
import type { CapacityTask } from './claude-capacity.ts';
import { recoverDiedPreparations, settlementOwed } from './settle.ts';

const ended = spawnSync('true').pid!;
const attempt = (n: number) => ({ n, pid: ended, engine: 'codex',
  output: `${import.meta.dir}/../../.temp/settle-pass-missing-${ended}-${n}.json` }) as Attempt;
const task = (fields: Partial<Task>) => ({ id: 'G-001', state: 'exited', attempts: [attempt(1)], ...fields }) as Task;

test('a pass takes the ledger lock only for a task whose ended attempt nobody is settling', () => {
  expect(settlementOwed(task({}))).toBe(true);
  expect(settlementOwed(task({ state: 'verified' }))).toBe(false);
  expect(settlementOwed(task({ state: 'cancelled' }))).toBe(false);
  expect(settlementOwed(task({ state: 'starting', attempts: [] }))).toBe(false);
  expect(settlementOwed(task({ waitingResume: {} as NonNullable<Task['waitingResume']> }))).toBe(false);
  const settled = { attempt: 1, token: 'a', owner: { pid: ended }, settledAt: '2026-10-13T21:00:00Z' };
  expect(settlementOwed(task({ settlement: settled }))).toBe(false);
  expect(settlementOwed(task({ attempts: [attempt(1), attempt(2)], settlement: settled }))).toBe(true);
  expect(settlementOwed(task({ settlement: { attempt: 1, token: 'a', owner: { pid: process.pid } } }))).toBe(false);
  expect(settlementOwed(task({ settlement: { attempt: 1, token: 'a', owner: { pid: ended } } }))).toBe(true);
});

test.each(['running', 'stopped', 'exited'] as const)('a quota-paused %s task is not claimed as an ended worker', state => {
  const current = task({ state, settlement: { attempt: 1, token: 'dead-owner', owner: { pid: ended } } }) as CapacityTask;
  const capacity: NonNullable<CapacityTask['claudeCapacity']> = {
    attempt: 1, owner: { pid: ended, start: '1', boot: 'fixture', cgroup: '' },
    pause: { at: Date.now(), stage: 'interrupt', signalledAt: Date.now(), reason: 'about-reserve' },
  };
  current.claudeCapacity = capacity;
  expect(settlementOwed(current)).toBe(false);
  capacity.pause!.stage = 'waiting';
  expect(settlementOwed(current)).toBe(false);
  // The durable marker alone does not prevent settlement after a real resume/exit.
  delete capacity.pause;
  expect(settlementOwed(current)).toBe(true);
});

test('a preparation whose process died is removed and its brief queued again; a live one is left alone', () => {
  const starting = (id: string, preparer?: { pid: number }) => task({ id, state: 'starting', attempts: [], goal: 'api',
    brief: `/repo/docs/goals/api/tasks/${id}.md`, worktree: `/repo/.temp/worktrees/${id}`, branch: `goal/${id}`,
    ...preparer ? { preparer } : {} });
  const ledger = { tasks: { 'G-001': starting('G-001', { pid: 1 }), 'G-002': starting('G-002', { pid: 2 }),
    'G-003': starting('G-003', { pid: 3 }), 'G-004': starting('G-004'), 'G-005': task({ id: 'G-005' }) },
    queue: { 'G-002': { id: 'G-002', brief: '/repo/docs/goals/api/tasks/G-002.md', goal: 'api',
      queuedAt: '2026-10-13T20:00:00.000Z', waits: ['G-002 is being prepared'], owner: { pid: 2 } } } } as unknown as QueueLedger;
  const died = recoverDiedPreparations(ledger, owner => owner.pid === 3);
  expect(died.map(item => item.id)).toEqual(['G-001', 'G-002']);
  expect(Object.keys(ledger.tasks)).toEqual(['G-003', 'G-004', 'G-005']);
  expect(ledger.queue!['G-001']).toMatchObject({ id: 'G-001', brief: '/repo/docs/goals/api/tasks/G-001.md', goal: 'api',
    waits: [], allowArea: true });
  expect(ledger.queue!['G-002']!.queuedAt).toBe('2026-10-13T20:00:00.000Z');
  expect(ledger.queue!['G-002']!.owner).toBeUndefined();
  expect(recoverDiedPreparations(ledger, owner => owner.pid === 3)).toEqual([]);
});
