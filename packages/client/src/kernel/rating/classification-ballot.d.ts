import type { RatingCapabilities } from './contract/capabilities.ts';
import type { Pool } from 'pg';
import type { KernelClock } from '../clock.ts';
import { type CurrentClassificationAssociation } from '../semantic/classification-association.ts';
import type { Access, Actor } from '../request/access.ts';
export declare const CLASSIFICATION_BALLOT_SET = "classification_ballot:set";
export declare const CLASSIFICATION_BALLOT_READ_OWN = "classification_ballot:read_own";
export declare const CLASSIFICATION_BALLOT_READ_AGGREGATE = "classification_ballot:read_aggregate";
export declare const CLASSIFICATION_BALLOT_MINIMUM = 5;
export type Assessment = 'support' | 'oppose';
export type SetClassificationBallotInput = {
    subjectId: string;
    associationId: string;
    assessment: Assessment;
    falsePositive: boolean;
    expectedRevision?: string;
};
export type BallotSlot = {
    binding_hash: Buffer;
    assessment: Assessment | null;
    falsePositive: boolean;
    revision: string;
    eligibilityGeneration: string;
    eligible: boolean;
};
type Aggregate = {
    supportCount: number;
    opposeCount: number;
    falsePositiveCount: number;
    generation: string;
    asOf: Date | string;
};
type Dependencies = {
    pool: Pool;
    access: Access;
    capabilities?: RatingCapabilities;
    clock?: KernelClock;
};
export declare class ClassificationBallotNotFoundError extends Error {
    constructor();
}
export declare class ClassificationBallotInvalidError extends Error {
    readonly field: string;
    constructor(field: string);
}
export declare class ClassificationBallotConflictError extends Error {
    constructor();
}
export declare function classificationAggregateView(associationId: string, row: Aggregate | null): {
    associationId: string;
    state: 'suppressed';
    pending: 'unknown';
    supportCount?: never;
    opposeCount?: never;
    falsePositiveCount?: never;
    supportFraction?: never;
    asOf?: never;
    generation?: never;
} | {
    associationId: string;
    state: 'published';
    supportCount: number;
    opposeCount: number;
    falsePositiveCount: number;
    supportFraction: number | null;
    asOf: string;
    generation: string;
    pending: 'unknown';
};
/** Read only the represented source partitions, never voter identities or contribution history.
 * A source checkpoint at its native head proves that lifecycle pages and their target writes
 * have run. Behind, moved or changed sources cannot certify eligible current totals. */
export declare function readClassificationAggregateObservation(pool: Pool, association: Pick<CurrentClassificationAssociation, 'subjectRoute' | 'subjectId' | 'associationId' | 'bindingHash'>, deadline: number): Promise<{
    value: {
        associationId: string;
        state: 'suppressed';
        pending: 'unknown';
        supportCount?: never;
        opposeCount?: never;
        falsePositiveCount?: never;
        supportFraction?: never;
        asOf?: never;
        generation?: never;
    } | {
        associationId: string;
        state: 'published';
        supportCount: number;
        opposeCount: number;
        falsePositiveCount: number;
        supportFraction: number | null;
        asOf: string;
        generation: string;
        pending: 'unknown';
    };
    current(): Promise<boolean>;
}>;
/** The clear writer and own-page advice share the same retained-slot binding precondition. */
export declare function classificationBallotClearPrecondition(retainedBinding: Uint8Array | null, current: Pick<CurrentClassificationAssociation, 'bindingHash'> | null): boolean;
export declare function createClassificationBallotCommands(config: Dependencies): {
    set: (actor: Actor, input: SetClassificationBallotInput, idempotencyKey: string) => Promise<{
        associationId: string;
        revision: string;
        delivery: 'unchanged' | 'enqueued';
    }>;
    clear: (actor: Actor, subjectId: string, associationId: string, idempotencyKey: string, expectedRevision?: string) => Promise<void>;
    readOwn: (actor: Actor, subjectId: string, associationId: string, deadline: number) => Promise<{
        associationId: string;
        hasBallot: boolean;
        assessment: Assessment | null;
        falsePositive: boolean;
        revision: string | null;
        pending: boolean;
    }>;
    readAggregate: (actor: Actor, subjectId: string, associationId: string, deadline: number) => Promise<{
        associationId: string;
        state: 'suppressed';
        pending: 'unknown';
        supportCount?: never;
        opposeCount?: never;
        falsePositiveCount?: never;
        supportFraction?: never;
        asOf?: never;
        generation?: never;
    } | {
        associationId: string;
        state: 'published';
        supportCount: number;
        opposeCount: number;
        falsePositiveCount: number;
        supportFraction: number | null;
        asOf: string;
        generation: string;
        pending: 'unknown';
    }>;
};
export {};
