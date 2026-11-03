import { expect, test } from 'bun:test';
import type {
  RealmClaimReviewInspection,
  RealmClaimReviewPage,
  RealmClaimReviewQuery,
} from '../src/index.ts';

const query = { inspectRequestId: '019a1b2c-3d4e-7f00-8a00-000000000001', limit: 20 } satisfies RealmClaimReviewQuery;
const pending: RealmClaimReviewPage = {
  claimRequests: [
    {
      realmId: '019a1b2c-3d4e-7f00-8a00-000000000002',
      requestId: query.inspectRequestId,
      claimantAccountId: '019a1b2c-3d4e-7f00-8a00-000000000003',
      state: 'pending',
      orphanedAt: '2026-11-04T00:00:00.000Z',
      claimEligibleAt: '2026-12-04T00:00:00.000Z',
      requestedAt: '2026-12-04T00:00:01.000Z',
      claimant: { label: '@alice', href: '/@alice' },
      approvalAdvice: {
        method: 'POST',
        destination: `/v1/realms/019a1b2c-3d4e-7f00-8a00-000000000002/claimRequests/${query.inspectRequestId}:approve`,
        requiredAction: 'realm:approve_claim',
        requiredHeader: 'Idempotency-Key',
      },
    },
  ],
  next: null,
  selectedRequest: null,
  realmPresentation: { state: 'unavailable' },
};
const approved: RealmClaimReviewInspection = {
  requestId: query.inspectRequestId,
  state: 'approved',
  orphanedAt: '2026-11-04T00:00:00.000Z',
  requestedAt: '2026-12-04T00:00:01.000Z',
  approvedAt: '2026-12-04T00:01:00.000Z',
  currentEpisode: false,
};

test('installed review exports carry current action and old approval variants', () => {
  expect(pending.claimRequests[0]?.approvalAdvice.requiredAction).toBe('realm:approve_claim');
  expect(approved.currentEpisode).toBe(false);
  expect(query.inspectRequestId).toBe(pending.claimRequests[0]?.requestId);
});
