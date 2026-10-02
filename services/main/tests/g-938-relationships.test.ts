import { expect, test } from 'bun:test';
import { Value } from 'typebox/value';
import {
  batchFollowCommand,
  defaultFollowLevel,
  followCommand,
  followKind,
  FOLLOWS_COST,
} from '../src/modules/follows/contract.ts';
import { resolveFollowIdentity } from '../src/modules/follows/targets.ts';
import type { WorkReadSession } from '../src/modules/work/read-session.ts';
import { RV } from '../src/modules/work/activate.ts';
import { watchCommand } from '../src/modules/notification/watch.ts';
import { replayFollowReceipt } from '../src/modules/follows/store.ts';

const id = (n: number) =>
  `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
test('G-938 Follow derives its kind and defaults; its person budget is independent of a twenty-item page', async () => {
  expect(
    Value.Check(followCommand, {
      profile: 'follow-command-v1',
      target: id(1),
      actingSubject: id(2),
      following: true,
      expectedRevision: null,
    }),
  ).toBe(true);
  expect(Value.Check(followKind, 'https://rezics.com/type/Species')).toBe(true);
  expect(FOLLOWS_COST.maximumFollowing).toBeGreaterThan(FOLLOWS_COST.pageSize * 100);
  expect(defaultFollowLevel('work')).toBe('all');
  expect(defaultFollowLevel('space')).toBe('highlights');
  expect(defaultFollowLevel('agent')).toBe('highlights');
  expect(defaultFollowLevel('concept')).toBe('off');
  expect(defaultFollowLevel('saved-view')).toBe('off');
  const session = {
    query: async (query: string) =>
      query.includes('SELECT DISTINCT ?space')
        ? []
        : [{ type: { type: 'uri', value: `${RV}Agent` } }],
  } as unknown as WorkReadSession;
  expect(await resolveFollowIdentity(session, id(1))).toEqual({ target: id(1), kind: 'agent' });
  await expect(resolveFollowIdentity(session, id(1), 'work')).rejects.toThrow(
    'kind does not match',
  );
});
test('G-938 manage batches preserve omitted settings and bound the atomic selection', () => {
  const body = {
    profile: 'follow-batch-v1',
    actingSubject: id(1),
    targets: [
      { target: id(2), following: false, expectedRevision: null },
      { target: id(3), level: 'off', pinPosition: 0, expectedRevision: null },
    ],
  };
  expect(Value.Check(batchFollowCommand, body)).toBe(true);
  expect(
    Value.Check(batchFollowCommand, {
      ...body,
      targets: Array.from({ length: 21 }, (_, n) => ({ target: id(n + 2) })),
    }),
  ).toBe(false);
  expect(
    Value.Check(batchFollowCommand, { ...body, targets: [{ target: id(2), level: 'digest' }] }),
  ).toBe(false);
});
test('G-938 Watch has one vocabulary for threads, proposals, releases and Collections', () => {
  for (const kind of ['thread', 'proposal', 'release', 'collection'])
    for (const level of ['participating', 'all', 'ignore']) {
      expect(
        Value.Check(watchCommand, {
          target: kind === 'proposal' ? `urn:rezics:proposal:${id(3).slice(-36)}` : id(3),
          actingSubject: id(1),
          kind,
          level,
          expectedRevision: null,
        }),
      ).toBe(true);
    }
  expect(
    Value.Check(watchCommand, {
      target: id(1),
      kind: 'person',
      level: 'all',
      actingSubject: id(2),
      expectedRevision: null,
    }),
  ).toBe(false);
});
test('G-938 pre-migration immutable receipts retain their identity and replay with original defaults', () => {
  const old = {
    profile: 'follow-receipt-v1',
    target: id(1),
    kind: 'work',
    following: true,
    actingSubject: id(2),
    revision: id(3).slice(-36),
    replayed: false,
  };
  expect(replayFollowReceipt(old) as unknown).toEqual({
    ...old,
    level: 'all',
    source: 'explicit',
    pinPosition: null,
    replayed: true,
  });
  expect(
    replayFollowReceipt({
      profile: 'follow-batch-receipt-v1',
      replayed: false,
      items: [{ target: id(1), kind: 'concept', following: true, revision: id(3).slice(-36) }],
    }),
  ).toMatchObject({
    items: [{ level: 'off', source: 'explicit', pinPosition: null }],
    replayed: true,
  });
});
