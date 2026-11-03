import type { ClientKernel } from '../http/kernel.ts';

type Routes = ClientKernel['~Routes']['v1'];
export type RealmClaimReviewOperation = Routes['realms'][':realmId']['claimRequests']['get'];
export type RealmClaimReviewQuery = RealmClaimReviewOperation['query'];
export type RealmClaimReviewPage = RealmClaimReviewOperation['response'][200];
export type RealmClaimReviewItem = RealmClaimReviewPage['claimRequests'][number];
export type RealmClaimReviewInspection = NonNullable<RealmClaimReviewPage['selectedRequest']>;
export type RealmClaimReviewClaimant = RealmClaimReviewItem['claimant'];
export type RealmClaimReviewApprovalAdvice = RealmClaimReviewItem['approvalAdvice'];
export type RealmClaimReviewPresentation = RealmClaimReviewPage['realmPresentation'];
