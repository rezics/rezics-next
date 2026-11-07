import { expect, test } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultPolicy } from './policy.ts';
import { MAX_WORKER_PROMPT_CHARACTERS, prepareOwnerDecisionPrompt, writeOwnerDecisionFile } from './owner-decisions.ts';
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
  const availableBudget = Math.min(MAX_WORKER_PROMPT_CHARACTERS, defaultPolicy.brief.bytes);
  const prepared = prepare('x'.repeat(availableBudget - 400));
  expect(prepared.prompt.length).toBeLessThanOrEqual(MAX_WORKER_PROMPT_CHARACTERS);
  expect(prepared.prompt).toContain('1 document reference(s) remain pending');
  expect(prepared.delivery?.documentRefs).toEqual([]);
});

test('a decision that does not fit the prompt is delivered as a pointer to its file, and the attempt starts', () => {
  const directory = temporaryDirectory();
  try {
    const worktree = join(directory.path, 'worker');
    mkdirSync(worktree);
    const body = decision('bounded', 'Use the current rule.', '2026-11-03T09:00:00.000Z');
    const prepare = (events: WorkerEvent[]) =>
      prepareOwnerDecisionPrompt(
        { ownerDecisionEvents: () => events },
        task(worktree),
        { taskId: 'task-a', attempt: 2 },
        'x'.repeat(MAX_WORKER_PROMPT_CHARACTERS - 10),
      );
    const accepted = event(1, body, body.createdAt);
    const prepared = prepare([accepted]);
    expect(prepared.prompt).toContain('does not fit this prompt: read .temp/owner-decisions/1.md before continuing.');
    expect(prepared.prompt).not.toContain('Use the current rule.');
    expect(prepared.delivery?.summaryDelivered).toBe(true);
    writeOwnerDecisionFile(worktree, prepared.file!);
    expect(readFileSync(join(worktree, '.temp/owner-decisions/1.md'), 'utf8')).toContain('Use the current rule.');
    const delivery = event(
      2,
      { decisionId: 'accounts:bounded', decisionSequence: 1, summaryDelivered: true, documentRefs: [] },
      body.createdAt,
      'owner-contract-decision-delivery',
    );
    expect(prepare([accepted, delivery]).prompt).toBe('x'.repeat(MAX_WORKER_PROMPT_CHARACTERS - 10));
  } finally {
    directory.close();
  }
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

test('an omitted reference stays pending across attempts while delivered context and foreign events do not repeat', () => {
  const directory = temporaryDirectory();
  try {
    const path = `docs/${'a'.repeat(80)}/${'b'.repeat(80)}/${'c'.repeat(80)}/contract.md`;
    mkdirSync(join(directory.path, path, '..'), { recursive: true });
    writeFileSync(join(directory.path, path), 'Canonical caller contract.');
    const body = {
      ...decision('partial', 'Apply the caller rule.', '2026-11-03T09:00:00.000Z'),
      documentRefs: [{ path }],
    };
    const accepted = event(1, body, body.createdAt);
    const first = prepareOwnerDecisionPrompt(
      { ownerDecisionEvents: () => [accepted] },
      task(directory.path),
      { taskId: 'task-a', attempt: 2 },
      'x'.repeat(Math.min(MAX_WORKER_PROMPT_CHARACTERS, defaultPolicy.brief.bytes) - 400),
    );
    expect(first.delivery?.documentRefs).toEqual([]);
    const delivered = event(2, first.delivery, body.createdAt, 'owner-contract-decision-delivery');
    const foreign = {
      ...event(3, { ...body, summary: 'Use a foreign task rule.' }, body.createdAt),
      task_id: 'other-task',
    };
    const current = { ...task(directory.path), currentAttempt: 3 };
    const next = prepareOwnerDecisionPrompt(
      { ownerDecisionEvents: () => [accepted, delivered, foreign] },
      current,
      { taskId: current.id, attempt: 3 },
      'Continue.',
    );
    expect(next.prompt).not.toContain('Decision: Apply');
    expect(next.prompt).not.toContain('foreign task rule');
    expect(next.delivery).toMatchObject({ originatingAttempt: 2, documentRefs: [{ path, status: 'delivered' }] });
  } finally {
    directory.close();
  }
});
