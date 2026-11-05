import { expect, test } from 'bun:test';
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MAX_WORKER_PROMPT_CHARACTERS, prepareOwnerDecisionPrompt } from './owner-decisions.ts';
import { temporaryDirectory } from './test-support.ts';
import type { WorkerEvent } from './store.ts';
import type { Task } from './types.ts';

function task(worktree = '/missing/worktree'): Task {
  return { id: 'task-a', currentAttempt: 2, worktree, brief: { manager: 'accounts' } } as Task;
}

function event(sequence: number, body: unknown, at: string, kind = 'owner-contract-decision-accepted'): WorkerEvent {
  return { sequence, task_id: 'task-a', attempt: 2, kind, at, body: JSON.stringify(body) };
}

const decision = (decisionId: string, summary: string, createdAt: string) => ({
  managerId: 'accounts',
  kind: 'decision',
  senderSessionId: 'authenticated-session',
  taskId: 'task-a',
  attempt: 2,
  decisionId,
  createdAt,
  summary,
  documentRefs: [],
});

test('a stale replay and foreign decision cannot override the later authenticated owner decision', () => {
  const events = [
    event(3, decision('older', 'Use the old rule.', '2026-11-03T08:00:00.000Z'), '2026-11-03T10:00:00.000Z'),
    event(1, decision('older', 'Use the old rule.', '2026-11-03T08:00:00.000Z'), '2026-11-03T08:00:00.000Z'),
    event(2, decision('current', 'Use the current rule.', '2026-11-03T09:00:00.000Z'), '2026-11-03T09:00:00.000Z'),
    event(
      4,
      { ...decision('foreign', 'Use a foreign rule.', '2026-11-03T11:00:00.000Z'), managerId: 'other-manager' },
      '2026-11-03T11:00:00.000Z',
    ),
  ];
  const result = prepareOwnerDecisionPrompt(
    { ownerDecisionEvents: () => events },
    task(),
    { taskId: 'task-a', attempt: 2 },
    'Continue.',
  );
  expect(result.prompt).toContain('Use the current rule.');
  expect(result.prompt).not.toContain('Use the old rule.');
  expect(result.prompt).not.toContain('Use a foreign rule.');

  const tiedLater = event(
    5,
    decision('same-time-later', 'Use the later sequence at this timestamp.', '2026-11-03T09:00:00.000Z'),
    '2026-11-03T09:00:00.000Z',
  );
  const tiedResult = prepareOwnerDecisionPrompt(
    { ownerDecisionEvents: () => [...events, tiedLater] },
    task(),
    { taskId: 'task-a', attempt: 2 },
    'Continue.',
  );
  expect(tiedResult.prompt).toContain('Use the later sequence at this timestamp.');
  expect(tiedResult.prompt).not.toContain('Use the current rule.');
});

test('document availability is refreshed between prompts after a prior delivery', () => {
  const directory = temporaryDirectory();
  try {
    const worktree = join(directory.path, 'worker');
    mkdirSync(worktree);
    mkdirSync(join(worktree, 'docs'));
    const path = 'docs/composition.md';
    writeFileSync(join(worktree, path), 'Available for the first prompt.');
    const body = {
      ...decision('changing-document', 'Apply the clarified composition rule.', '2026-11-03T09:00:00.000Z'),
      documentRefs: [{ path }],
    };
    const accepted = event(1, body, '2026-11-03T09:00:00.000Z');
    const prepare = (events: WorkerEvent[]) =>
      prepareOwnerDecisionPrompt(
        { ownerDecisionEvents: () => events },
        task(worktree),
        { taskId: 'task-a', attempt: 2 },
        'Continue.',
      );
    const first = prepare([accepted]);
    expect(first.delivery?.documentRefs).toEqual([{ path, status: 'delivered' }]);

    rmSync(join(worktree, path));
    const previousDelivery = event(
      2,
      {
        decisionId: 'accounts:changing-document',
        decisionSequence: 1,
        summaryDelivered: true,
        documentRefs: [{ path, status: 'delivered' }],
      },
      '2026-11-03T09:01:00.000Z',
      'owner-contract-decision-delivery',
    );
    const second = prepare([accepted, previousDelivery]);
    expect(second.prompt).toContain(`Document reference pending and unavailable in the worker worktree: ${path}`);
    expect(second.delivery?.documentRefs).toEqual([{ path, status: 'pending' }]);
  } finally {
    directory.close();
  }
});

test('a missing referenced document remains named and pending', () => {
  const worktree = '/missing/worktree';
  const body = {
    ...decision('doc-1', 'Apply the clarified composition rule.', '2026-11-03T09:00:00.000Z'),
    documentRefs: [{ path: 'docs/composition.md' }],
  };
  const result = prepareOwnerDecisionPrompt(
    { ownerDecisionEvents: () => [event(1, body, '2026-11-03T09:00:00.000Z')] },
    task(worktree),
    { taskId: 'task-a', attempt: 2 },
    'Continue.',
  );
  expect(result.prompt).toContain(
    'Document reference pending and unavailable in the worker worktree: docs/composition.md',
  );
  expect(result.delivery?.documentRefs).toEqual([{ path: 'docs/composition.md', status: 'pending' }]);
  expect(
    prepareOwnerDecisionPrompt(
      { ownerDecisionEvents: () => [event(1, body, '2026-11-03T09:00:00.000Z')] },
      task(worktree),
      { taskId: 'task-a', attempt: 1 },
      'Continue.',
    ).prompt,
  ).toBe('Continue.');
});

test('unverified decisions and delivery bodies cannot inject or suppress an accepted decision', () => {
  const body = decision('current', 'Use the current rule.', '2026-11-03T09:00:00.000Z');
  const legacy = event(1, body, body.createdAt, 'owner-contract-decision');
  const prepare = (events: WorkerEvent[]) =>
    prepareOwnerDecisionPrompt(
      { ownerDecisionEvents: () => events },
      task(),
      { taskId: 'task-a', attempt: 2 },
      'Continue.',
    );
  expect(prepare([legacy]).prompt).toBe('Continue.');
  const forgedDelivery = event(
    3,
    { decisionId: 'accounts:current', summaryDelivered: true },
    body.createdAt,
    'owner-contract-decision-delivery',
  );
  expect(prepare([legacy, event(2, body, body.createdAt), forgedDelivery]).prompt).toContain(body.summary);
});

test('the decision shares the total prompt budget and omitted references remain pending', () => {
  const body = {
    ...decision('bounded', 'Use the current rule.', '2026-11-03T09:00:00.000Z'),
    documentRefs: [{ path: `docs/${'x'.repeat(500)}.md` }],
  };
  const prepare = (prompt: string) =>
    prepareOwnerDecisionPrompt(
      { ownerDecisionEvents: () => [event(1, body, body.createdAt)] },
      task(),
      { taskId: 'task-a', attempt: 2 },
      prompt,
    );
  const prepared = prepare('x'.repeat(MAX_WORKER_PROMPT_CHARACTERS - 400));
  expect(prepared.prompt.length).toBeLessThanOrEqual(MAX_WORKER_PROMPT_CHARACTERS);
  expect(prepared.prompt).toContain('1 document reference(s) remain pending');
  expect(prepared.delivery?.documentRefs).toEqual([]);
  expect(() => prepare('x'.repeat(MAX_WORKER_PROMPT_CHARACTERS - 10))).toThrow('total prompt input limit');
});

test('a reference escaping through a parent symlink stays named and pending', () => {
  const directory = temporaryDirectory();
  try {
    mkdirSync(join(directory.path, 'worker'));
    writeFileSync(join(directory.path, 'outside.md'), 'Unavailable to the worker.');
    symlinkSync(directory.path, join(directory.path, 'worker/docs'));
    const body = {
      ...decision('escaped', 'Apply the rule.', '2026-11-03T09:00:00.000Z'),
      documentRefs: [{ path: 'docs/outside.md' }],
    };
    const result = prepareOwnerDecisionPrompt(
      { ownerDecisionEvents: () => [event(1, body, body.createdAt)] },
      task(join(directory.path, 'worker')),
      { taskId: 'task-a', attempt: 2 },
      'Continue.',
    );
    expect(result.prompt).toContain('pending and unavailable in the worker worktree: docs/outside.md');
    expect(result.delivery?.documentRefs).toEqual([{ path: 'docs/outside.md', status: 'pending' }]);
  } finally {
    directory.close();
  }
});
