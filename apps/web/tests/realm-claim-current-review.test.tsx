import { expect, test } from 'bun:test';
import {
  createRealmClaimReview,
  type RealmClaimReviewRead,
  type RealmClaimReviewRequest,
} from '../src/community/realm-claim-review';

const realmId = '01a1a000-0000-7000-8000-000000000011';
const row: RealmClaimReviewRequest = {
  realmId,
  requestId: '01a1a000-0000-7000-8000-000000000099',
  claimantAccountId: '01a1a000-0000-7000-8000-000000000033',
  state: 'pending',
  orphanedAt: '2026-09-01T10:00:00.000Z',
  claimEligibleAt: '2026-10-01T10:00:00.000Z',
  requestedAt: '2026-10-31T10:00:00.000Z',
};

test('retry preserves an opaque cursor and a stale cursor restarts from the first page', async () => {
  const cursor = 'native.signed/opaque?realm=unchanged';
  const reads: (string | undefined)[] = [];
  const responses: RealmClaimReviewRead[] = [
    { kind: 'unavailable' },
    { kind: 'stale-cursor' },
    { kind: 'ready', page: { claimRequests: [], next: null } },
  ];
  const control = createRealmClaimReview(
    realmId,
    { kind: 'ready', page: { claimRequests: [row], next: cursor } },
    {
      read: async ({ cursor: selected }) => {
        reads.push(selected);
        return responses.shift()!;
      },
      approve: async () => ({ kind: 'unavailable' }),
    },
  );

  await control.next();
  await control.retryPage();
  expect(control.getSnapshot().read.kind).toBe('stale-cursor');
  await control.retryPage();
  await control.restart();

  expect(reads).toEqual([cursor, cursor, undefined]);
  expect(control.getSnapshot().read).toEqual({ kind: 'ready', page: { claimRequests: [], next: null } });
});
