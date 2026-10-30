import { useMemo } from 'react';
import { RealmClaimReviewView } from '../../../community/realm-claim-review-page';
import type {
  RealmClaimReviewAdapter,
  RealmClaimReviewRead,
  RealmClaimReviewRequest,
} from '../../../community/realm-claim-review';

// Declared response examples only: these are not recordings or proof of native approval.
export const reviewRequest: RealmClaimReviewRequest = {
  realmId: '01a1a000-0000-7000-8000-000000000011',
  requestId: '01a1a000-0000-7000-8000-000000000099',
  claimantAccountId: '01a1a000-0000-7000-8000-000000000033',
  state: 'pending',
  orphanedAt: '2026-09-01T10:00:00.000Z',
  claimEligibleAt: '2026-10-01T10:00:00.000Z',
  requestedAt: '2026-10-31T10:00:00.000Z',
};
export type ReviewScenario = 'pending' | 'empty' | 'sparse' | 'denied' | 'conflict' | 'uncertain' | 'success';
export const pendingReview: RealmClaimReviewRead = {
  kind: 'ready',
  page: { claimRequests: [reviewRequest], next: null },
};

export function reviewExample(scenario: ReviewScenario): {
  initial: RealmClaimReviewRead;
  adapter: RealmClaimReviewAdapter;
} {
  let applied = false;
  let attemptedKey: string | null = null;
  const initial: RealmClaimReviewRead =
    scenario === 'denied'
      ? { kind: 'denied' }
      : scenario === 'empty' || scenario === 'sparse'
        ? { kind: 'ready', page: { claimRequests: [], next: scenario === 'sparse' ? 'opaque-native-next' : null } }
        : pendingReview;
  return {
    initial,
    adapter: {
      read: async (input) =>
        applied
          ? { kind: 'ready', page: { claimRequests: [], next: null } }
          : scenario === 'sparse' && input.cursor
            ? pendingReview
            : initial,
      approve: async (input) => {
        if (scenario === 'denied') return { kind: 'denied' };
        if (scenario === 'conflict') return { kind: 'conflict' };
        if (attemptedKey && attemptedKey !== input.idempotencyKey) throw new Error('Approval retry changed its key');
        if (scenario === 'uncertain' && !attemptedKey) {
          attemptedKey = input.idempotencyKey;
          applied = true;
          return { kind: 'unavailable' };
        }
        applied = true;
        return {
          kind: 'approved',
          claim: {
            realmId: reviewRequest.realmId,
            requestId: reviewRequest.requestId,
            claimantAccountId: reviewRequest.claimantAccountId,
            state: 'owned',
            orphanedAt: reviewRequest.orphanedAt,
            approvedAt: '2026-10-31T10:05:00.000Z',
          },
        };
      },
    },
  };
}

export function RealmClaimReviewExample({ scenario = 'pending' }: { scenario?: ReviewScenario }) {
  const example = useMemo(() => reviewExample(scenario), [scenario]);
  return <RealmClaimReviewView key={scenario} realmId={reviewRequest.realmId} {...example} />;
}
