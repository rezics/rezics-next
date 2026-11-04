import { expect, test } from 'bun:test';
import {
  projectCommunityActivitySelection,
  projectCommunityComments,
  projectCommunityCommentsBatch,
  projectPublicConversationActivity,
  type CommunityActivityWitness,
  type CommunityComments,
  type ConversationActivityCurrent,
} from '../../src/content/community-projection/index.ts';

const anonymous = { kind: 'anonymous' } as const;
const account = { kind: 'account', accountId: 'viewer-one' } as const;
const time = '2026-11-04T00:00:00.000Z';
const current = (): Extract<CommunityActivityWitness, { state: 'current' }> => ({
  state: 'current',
  threadId: 'thread-one',
  cohort: { kind: 'public' },
  count: { kind: 'exact', value: 0 },
  lastActivityAt: null,
  source: { epoch: 2, position: '9007199254740993' },
});

test('community comments preserve exact zero, lower bounds, viewer cohorts and unavailable evidence', () => {
  const zero = current();
  const lower: CommunityActivityWitness = {
    ...zero,
    cohort: { kind: 'viewer', accountId: account.accountId },
    count: { kind: 'lower-bound', value: 10_000 },
    lastActivityAt: time,
  };
  expect(projectCommunityComments(zero.threadId, zero, anonymous)).toEqual({
    state: 'current',
    cohort: 'public',
    count: zero.count,
    lastActivityAt: null,
    source: zero.source,
  });
  expect(projectCommunityComments(zero.threadId, lower, account)).toMatchObject({
    state: 'current',
    cohort: 'viewer',
    count: lower.count,
    lastActivityAt: time,
  });
  for (const actor of [anonymous, { kind: 'account', accountId: 'other-viewer' } as const])
    expect(projectCommunityComments(zero.threadId, lower, actor)).toEqual({ state: 'unavailable' });
  expect(projectCommunityComments('other-thread', zero, account)).toEqual({ state: 'unavailable' });
  expect(projectCommunityComments(zero.threadId, undefined, account)).toEqual({ state: 'unavailable' });
  expect(projectCommunityCommentsBatch([zero.threadId, 'missing'], [zero, zero], account)).toEqual(
    new Map<string, CommunityComments>([
      [zero.threadId, { state: 'unavailable' }],
      ['missing', { state: 'unavailable' }],
    ]),
  );
});

test('malformed selected values stay unavailable and changed evidence cannot rewrite a selected observation', () => {
  const zero = current();
  const malformed = [
    { count: { kind: 'exact', value: -1 } },
    { count: { kind: 'exact', value: 0.5 } },
    { count: { kind: 'exact', value: Number.MAX_SAFE_INTEGER + 1 } },
    { count: { kind: 'estimate', value: 1 } },
    { count: { kind: 'exact', value: 1 }, lastActivityAt: 'invalid' },
    { lastActivityAt: time },
    { source: { epoch: 0, position: '1' } },
    { source: { epoch: 1.5, position: '1' } },
    ...['0', '-1', '01', '1.5'].map((position) => ({ source: { epoch: 2, position } })),
  ];
  for (const patch of malformed) {
    const evidence = Object.assign(current(), patch);
    expect(projectCommunityComments(zero.threadId, evidence, anonymous)).toEqual({ state: 'unavailable' });
  }
  const selected = projectCommunityCommentsBatch([zero.threadId], [zero], anonymous);
  Object.assign(zero.count, { value: 2 });
  Object.assign(zero.source, { epoch: 3, position: '9007199254740994' });
  const confirmed = projectCommunityCommentsBatch([zero.threadId], [zero], anonymous);
  expect(selected.get(zero.threadId)).toMatchObject({ count: { value: 0 }, source: { epoch: 2 } });
  expect(confirmed.get(zero.threadId)).toMatchObject({ count: { value: 2 }, source: { epoch: 3 } });
  expect(confirmed).not.toEqual(selected);
});

test('native selection preserves the source head, independent anchor and distinct public count/time semantics', () => {
  const anchor = { epoch: 8, position: 99n };
  const selected: ConversationActivityCurrent<typeof anchor> = {
    threadId: 'thread-one',
    status: 'current',
    cohort: 'public',
    replyCount: { kind: 'lower-bound', value: 10_000 },
    lastContributionAt: time,
    witness: {
      threadId: 'thread-one',
      boardId: 'board-one',
      realmId: null,
      threadSecurityRevision: '1',
      boardSecurityRevision: '2',
      boardGeneration: '3',
      generation: '4',
      sourceHead: { epoch: 2, position: 9007199254740993n, eventSeq: 1_000 },
      source: anchor,
    },
  };
  const read = projectCommunityActivitySelection([
    selected,
    {
      threadId: 'withheld',
      status: 'withheld',
      reason: 'coverage',
    },
  ]);
  expect(read.anchors).toEqual([anchor]);
  expect(projectCommunityCommentsBatch(['thread-one', 'withheld'], read.items, anonymous)).toEqual(
    new Map([
      [
        'thread-one',
        {
          state: 'current',
          cohort: 'public',
          count: selected.replyCount,
          lastActivityAt: time,
          source: { epoch: 2, position: '9007199254740993' },
        },
      ],
      ['withheld', { state: 'unavailable' }],
    ]),
  );
  Object.assign(selected.replyCount, { kind: 'exact', value: 0 });
  const publicActivity = projectPublicConversationActivity(selected);
  expect(publicActivity).toEqual({
    state: 'current',
    cohort: 'public',
    count: { kind: 'exact', value: 0 },
    lastActivityAt: time,
  });
  // Home/Subject retain the opening's publication time; Board/Realm require zero/null.
  expect(
    projectCommunityComments('thread-one', projectCommunityActivitySelection([selected]).items[0], anonymous),
  ).toEqual({ state: 'unavailable' });
  expect(projectPublicConversationActivity(undefined)).toEqual({ state: 'withheld' });
  expect(projectPublicConversationActivity({ threadId: 'withheld', status: 'withheld', reason: 'stale' })).toEqual({
    state: 'withheld',
  });
  expect(read.items[0]).toMatchObject({ count: { kind: 'lower-bound', value: 10_000 } });
  Object.assign(selected.witness, { threadId: 'changed-thread' });
  expect(projectCommunityActivitySelection([selected]).items).toEqual([
    { state: 'unavailable', threadId: 'thread-one' },
  ]);
});
