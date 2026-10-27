import { expect, test } from 'bun:test';
import { partitionOf, routeOf } from '../services/kernel/src/route/route.ts';
import type { FollowRow, FollowTargetType } from '../services/kernel/src/library/follow-model.ts';
import {
  FOLLOW_COUNTS_MISSING_DRIVER,
  FOLLOW_COUNTS_ROUTES,
  type CountFixture,
  type CountInspection,
  type FollowCountsDriver,
  type OutgoingCountDTO,
  type TargetCountDTO,
} from './follow-counts-driver.ts';

// Static identity/shape examples only. These never implement permission, counting or a native driver.
const accountId = '019a0000-0000-7000-8000-000100000001';
const agentId = '019a0000-0000-7000-8000-002000000002';
const otherId = '019a0000-0000-7000-8000-003000000003';
const target = { targetType: 'subject', targetId: agentId } as const;

test('private count binding keeps exact routes marker and closed DTO examples', () => {
  expect(FOLLOW_COUNTS_MISSING_DRIVER).toBe('Follow count outcome driver is required');
  expect(FOLLOW_COUNTS_ROUTES).toEqual({
    target: '/v1/followCounts/:targetType/:targetId',
    outgoing: '/v1/followCounts/outgoing',
  });
  const zero = { ...target, followerCount: 0 } satisfies TargetCountDTO;
  const outgoing = { followingCount: 2 } satisfies OutgoingCountDTO;
  expect(Object.keys(zero).sort()).toEqual(['followerCount', 'targetId', 'targetType']);
  expect(Object.keys(outgoing)).toEqual(['followingCount']);
  expect(Number.isSafeInteger(zero.followerCount)).toBe(true);
  const types = ['subject', 'collection', 'space'] satisfies FollowTargetType[];
  expect(types).toHaveLength(3);
});

test('account agent fixture resolves a distinct account identity and legal source partition', () => {
  const principal = { accountId, credential: 'fixture-shape-only' };
  const other = { accountId: otherId, credential: 'other-fixture-shape-only' };
  const fixture = {
    target,
    targetAccountId: accountId,
    manager: principal,
    granted: other,
    follower: other,
    other,
    staff: other,
    noScope: other,
    suspended: other,
    unknown: { targetType: 'subject', targetId: otherId },
  } satisfies CountFixture;
  expect(fixture.targetAccountId).not.toBe(fixture.target.targetId);
  expect(fixture.manager.accountId).toBe(fixture.targetAccountId);
  expect(routeOf(accountId)).toBe(1);
  expect(routeOf(agentId)).toBe(32);
  expect(partitionOf(routeOf(accountId)!)).not.toBe(partitionOf(routeOf(agentId)!));
  for (const id of [accountId, agentId, otherId]) {
    expect(partitionOf(routeOf(id)!)).toBeGreaterThanOrEqual(0);
    expect(partitionOf(routeOf(id)!)).toBeLessThan(4096);
  }
  const unowned = { ...fixture, targetAccountId: null } satisfies CountFixture;
  expect(unowned.targetAccountId).toBeNull();
});

test('inspection shape preserves the native source tombstone and payload-free terminal evidence', () => {
  const source = {
    route: routeOf(accountId)!,
    accountId,
    targetId: agentId,
    targetType: 'subject',
    state: 'unfollowed',
    reason: 'explicit',
    createdAt: '2026-10-28T00:00:00.000Z',
    updatedAt: '2026-10-28T00:01:00.000Z',
    transactionId: '019a0000-0000-7000-8000-000100000004',
  } satisfies FollowRow;
  const inspection = {
    source,
    targetRows: [],
    effects: [],
    privatePayloads: [],
    terminalFences: [{ accountId }],
  } satisfies CountInspection;
  expect(inspection.source).toBe(source);
  expect(inspection.source.state).toBe('unfollowed');
  expect(Object.keys(inspection.terminalFences[0]!)).toEqual(['accountId']);
  // Compile-time boundary examples, without defining any factory or lifecycle policy.
  type LifecycleState = Parameters<FollowCountsDriver['accountState']>[1];
  const states = ['active', 'suspended', 'deleted'] satisfies LifecycleState[];
  const terminalSignal = [accountId] satisfies Parameters<FollowCountsDriver['accountSignal']>;
  const purge = { pages: 1, maxRows: 100, complete: true } satisfies Awaited<ReturnType<FollowCountsDriver['purge']>>;
  expect(states).toEqual(['active', 'suspended', 'deleted']);
  expect(terminalSignal).toEqual([accountId]);
  expect(Object.keys(purge).sort()).toEqual(['complete', 'maxRows', 'pages']);
});
