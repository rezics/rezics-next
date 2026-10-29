import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { loadDecisionPage, canAppealDecision } from '../src/moderation/decision-read';
import { submitDecisionAppeal } from '../src/moderation/appeal';

const decidedAt = '2026-01-01T12:00:00.000Z';
const decision = {
  id: 'decision-1',
  targetKind: 'post' as const,
  targetId: 'post-1',
  action: 'takedown' as const,
  statement: 'This post violates the board rules.',
  decidedAt,
  appealDeadline: '2026-07-03T12:00:00.000Z',
  appeal: null,
};

test('decision page reads its decision and the applicable existing record once each', async () => {
  const calls: string[] = [];
  const page = await loadDecisionPage('decision-1', {
    decision: async (id) => {
      calls.push(`decision:${id}`);
      return decision;
    },
    post: async (id) => {
      calls.push(`post:${id}`);
      return { id, threadId: 'thread-1', createdAt: decidedAt, authorId: 'author-1', title: 'The affected post' };
    },
    thread: async (id) => {
      calls.push(`thread:${id}`);
      return { id, createdAt: decidedAt, authorId: 'author-1', title: 'The affected thread' };
    },
  });

  expect(page).toMatchObject({ decision, target: { id: 'post-1', title: 'The affected post' } });
  expect(calls).toEqual(['decision:decision-1', 'post:post-1']);
  expect(calls).toHaveLength(2);
});

test('appeal access is inclusive of the deadline and limited to the author without an existing appeal', () => {
  expect(canAppealDecision(decision, 'author-1', Date.parse(decision.appealDeadline))).toBe(true);
  expect(canAppealDecision(decision, 'author-1', Date.parse(decision.appealDeadline) + 1)).toBe(false);
  expect(canAppealDecision(decision, 'someone-else', Date.parse(decidedAt))).toBe(false);
  expect(
    canAppealDecision({ ...decision, appeal: { id: 'appeal-1', outcome: null } }, 'author-1', Date.parse(decidedAt)),
  ).toBe(false);
});

test('a successful appeal is followed by the decision read and becomes pending', async () => {
  const calls: string[] = [];
  const pending = {
    ...decision,
    appeal: { id: 'appeal-1', outcome: null, statement: 'I disagree.', resolvedAt: null },
  };
  const result = await submitDecisionAppeal('decision-1', 'I disagree.', {
    appeal: async (id, statement) => {
      calls.push(`appeal:${id}:${statement}`);
      return { status: 201 };
    },
    decision: async (id) => {
      calls.push(`decision:${id}`);
      return pending;
    },
  });

  expect(result).toMatchObject({ state: 'pending', decision: pending });
  expect(calls).toEqual(['appeal:decision-1:I disagree.', 'decision:decision-1']);
});

test('a 422 length error preserves the draft while late and duplicate appeals use the next decision state', async () => {
  const draft = 'x'.repeat(2001);
  let next = decision;
  const reader = { decision: async () => next };
  const tooLong = await submitDecisionAppeal('decision-1', draft, {
    appeal: async () => ({ status: 422 }),
    ...reader,
  });
  expect(tooLong).toMatchObject({ state: 'invalid', text: draft });

  next = { ...decision, appeal: { id: 'appeal-1', outcome: null, statement: 'Earlier appeal', resolvedAt: null } };
  for (const status of [409, 422]) {
    const refreshed = await submitDecisionAppeal('decision-1', 'My reason', {
      appeal: async () => ({ status }),
      ...reader,
    });
    expect(refreshed).toMatchObject({ state: 'updated', decision: next });
  }
});

test('decision route is signed-in, noindex and private, and refused reads become not found', async () => {
  const route = await readFile(new URL('../src/routes/moderation/decisions.$id.tsx', import.meta.url), 'utf8');
  const read = await readFile(new URL('../src/moderation/decision-read.ts', import.meta.url), 'utf8');
  expect(route).toMatch(/beforeLoad:\s*requireSignedIn/);
  expect(route).toMatch(/noindex, nofollow/);
  expect(read).toMatch(/notFound\(/);
});
