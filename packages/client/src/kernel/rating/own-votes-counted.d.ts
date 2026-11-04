import type { Pool, PoolClient } from 'pg';
import type { Access, Actor } from '../request/access.ts';
import { STANDARD_QUESTION_ID } from './standard-question.ts';
import { type VoteReviewGuard, type VoteReviewSlot } from './own-votes-review.ts';
export declare const OWN_COUNTED_VOTE_TARGET_LIMIT = 100;
export type StandardRatingMeasurement = Readonly<{
    questionId: typeof STANDARD_QUESTION_ID;
    revision: 1;
    minimumUnits: 0;
    maximumUnits: 20;
    stepUnits: 1;
}>;
export declare const STANDARD_RATING_MEASUREMENT: StandardRatingMeasurement;
export type OwnCountedVoteRequest = Readonly<{
    actor: Actor;
    targetIds: readonly string[];
}>;
export type OwnCountedVoteIdentity = Readonly<{
    requestedTargetId: string;
    countingTargetId: string;
    sourceEpoch: string;
}>;
export type OwnCountedVotePreparedTarget = OwnCountedVoteIdentity | Readonly<{
    requestedTargetId: string;
    state: 'unavailable';
}>;
export type OwnCountedVoteQuestionObservation = Readonly<{
    questionId: string;
    revision: number;
    ownerId: string | null;
    realmId: string | null;
    meaning: string | null;
    grain: string;
    minimumUnits: number;
    maximumUnits: number;
    stepUnits: number;
    lifecycleState: string;
    lifecycleRevision: number;
}>;
export type OwnCountedVoteAccountObservation = Readonly<{
    route: number;
    accountId: string;
    kind: string;
    state: string;
    controllerId: string | null;
    minimumAuthnEpoch: string;
    fenced: boolean;
    transactionId: string;
}>;
export type OwnCountedVotePreparation = Readonly<{
    requestFingerprint: string;
    preparationFingerprint: string;
    identityFingerprint: string;
    visibilityFingerprint: string;
    requestedTargetIds: readonly string[];
    targets: readonly OwnCountedVotePreparedTarget[];
    account: OwnCountedVoteAccountObservation;
    question: OwnCountedVoteQuestionObservation | null;
}>;
export type OwnCountedVotePrepareResult = Readonly<{
    status: 'prepared';
    preparation: OwnCountedVotePreparation;
}> | Readonly<{
    status: 'preparing';
    reason: 'identity-pending' | 'identity-changed' | 'question-changed';
    retry: 'same-input';
    targets: readonly Readonly<{
        requestedTargetId: string;
        state: 'pending';
    }>[];
}>;
export type OwnCountedVoteRow = Readonly<{
    countingTargetId: string;
    originalTargetId: string;
    units: number | null;
    revision: number;
    countedRevision: number;
    changedAt: string;
    transactionId: string;
}>;
export type OwnCountedVoteReadResult = Readonly<{
    status: 'read';
    requestFingerprint: string;
    preparationFingerprint: string;
    account: OwnCountedVoteAccountObservation;
    rows: readonly OwnCountedVoteRow[];
    slots: readonly VoteReviewSlot[];
    rowFingerprint: string;
}> | Readonly<{
    status: 'preparing';
    reason: 'request-changed' | 'preparation-changed' | 'account-changed';
    retry: 'same-input';
}>;
export type OwnCountedVoteObservation = (OwnCountedVoteIdentity & Readonly<{
    state: 'counted';
    review: VoteReviewGuard;
    measurement: StandardRatingMeasurement;
    originalTargetId: string;
    units: number;
    revision: number;
    countedRevision: number;
    changedAt: string;
    transactionId: string;
}>) | (OwnCountedVoteIdentity & Readonly<{
    state: 'clear';
    review: VoteReviewGuard;
    measurement: StandardRatingMeasurement;
    originalTargetId: string;
    units: null;
    revision: number;
    countedRevision: number;
    changedAt: string;
    transactionId: string;
}>) | (OwnCountedVoteIdentity & Readonly<{
    state: 'absent';
    review: VoteReviewGuard;
    measurement: StandardRatingMeasurement;
}>) | Readonly<{
    requestedTargetId: string;
    state: 'unavailable';
}>;
export type OwnCountedVoteResult = Readonly<{
    status: 'current';
    measurement: StandardRatingMeasurement;
    requestedTargetIds: readonly string[];
    observations: readonly OwnCountedVoteObservation[];
}> | Readonly<{
    status: 'preparing';
    reason: 'request-changed' | 'preparation-changed' | 'account-changed' | 'question-changed' | 'identity-changed' | 'vote-changed';
    retry: 'same-input';
}>;
export type OwnCountedVoteReaderDependencies = Readonly<{
    pool: Pool;
    access: Access;
}>;
export type OwnCountedVoteReader = Readonly<{
    prepare(request: OwnCountedVoteRequest, deadline: number): Promise<OwnCountedVotePrepareResult>;
    read(client: Pick<PoolClient, 'query'>, request: OwnCountedVoteRequest, preparation: OwnCountedVotePreparation): Promise<OwnCountedVoteReadResult>;
    finish(request: OwnCountedVoteRequest, preparation: OwnCountedVotePreparation, readResult: OwnCountedVoteReadResult, deadline: number): Promise<OwnCountedVoteResult>;
}>;
export declare function createOwnCountedVoteReader(deps: OwnCountedVoteReaderDependencies): OwnCountedVoteReader;
