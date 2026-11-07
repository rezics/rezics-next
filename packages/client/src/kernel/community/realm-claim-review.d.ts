import type { Pool } from 'pg';
import type { Access, Actor } from '../request/access.ts';
export type RealmClaimantPresentation = Readonly<{
    label: string;
    href: string | null;
}>;
export type RealmClaimApprovalAdvice = Readonly<{
    method: 'POST';
    destination: string;
    requiredAction: 'realm:approve_claim';
    requiredHeader: 'Idempotency-Key';
}>;
export type RealmClaimReviewItem = Readonly<{
    realmId: string;
    requestId: string;
    claimantAccountId: string;
    state: 'pending';
    orphanedAt: string;
    claimEligibleAt: string;
    requestedAt: string;
    claimant: RealmClaimantPresentation;
    approvalAdvice: RealmClaimApprovalAdvice;
}>;
export type RealmClaimReviewInspection = Readonly<{
    requestId: string;
    claimantAccountId: string;
    state: 'pending';
    orphanedAt: string;
    claimEligibleAt: string;
    requestedAt: string;
    currentEpisode: true;
    claimant: RealmClaimantPresentation;
    approvalAdvice: RealmClaimApprovalAdvice;
}> | Readonly<{
    requestId: string;
    state: 'approved';
    orphanedAt: string;
    requestedAt: string;
    approvedAt: string;
    currentEpisode: false;
}>;
export type RealmClaimReviewPresentation = Readonly<{
    state: 'available';
    name: string;
    description: string;
}> | Readonly<{
    state: 'unavailable';
}>;
export type RealmClaimReviewPage = Readonly<{
    claimRequests: readonly RealmClaimReviewItem[];
    next: string | null;
    selectedRequest: RealmClaimReviewInspection | null;
    realmPresentation: RealmClaimReviewPresentation;
}>;
/** One current episode, one bounded seek, then fresh authority and source checks.
 * Accounts' approval command remains the only writer and grant producer.
 */
export declare function listRealmClaimRequests(deps: {
    pool: Pool;
    access: Access;
    clock: () => Date;
    deadlineNow: () => number;
}, actor: Actor, input: {
    realmId: string;
    cursor?: string;
    limit?: number;
    inspectRequestId?: string;
}, context: {
    deadline: number;
}): Promise<RealmClaimReviewPage>;
