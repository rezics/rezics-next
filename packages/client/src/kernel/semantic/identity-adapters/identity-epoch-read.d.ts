import { identityRatingReviewEvidence, type IdentityRatingControlLocator, type IdentityRatingNativeEvidence, type IdentityRatingReviewOperand, type IdentityRatingReviewResult, type IdentityRatingReviewUnavailableReason } from '../identity-core/index.ts';
import type { Pool, PoolClient } from 'pg';
import type { IdentityMapping } from './identity-epoch-contract.ts';
export type { IdentityRatingControlLocator, IdentityRatingReviewOperand, IdentityRatingReviewResult, IdentityRatingReviewUnavailableReason, IdentityRatingNativeEvidence, };
type Queryable = Readonly<{
    query: (text: string, values?: unknown[]) => Promise<{
        rows: Record<string, unknown>[];
    }>;
}>;
export { identityRatingReviewEvidence };
/** Bounded exact reviewed mapping evidence; source/control homes are released independently and double-collected. */
export declare function readIdentityRatingReview(pool: Pool, input: Readonly<{
    requestedOriginalId: string;
    canonicalTerminalId: string;
    deadline: number;
}>): Promise<IdentityRatingReviewResult>;
/** One bounded reread on the caller's original command connection after its native home lock. */
export declare function readIdentityRatingEvidenceInTransaction(client: Queryable, input: Readonly<{
    sourceIdentities: readonly string[];
    commandHome: number;
}>): Promise<Readonly<{
    state: 'ready';
    evidence: IdentityRatingNativeEvidence;
}> | Readonly<{
    state: 'foreign-control';
}>>;
/** Pure classifier reused by the transaction participant after it has acquired the native owner fence. */
export declare function classifyIdentityRatingReviewEvidence(requestedOriginalId: string, canonicalTerminalId: string, sourceIdentities: readonly string[], sourceHomes: readonly number[], evidence: IdentityRatingNativeEvidence): IdentityRatingReviewResult;
/** Bounded exact mapping proof, with source and control homes released independently. */
export declare function readIdentityMappings(pool: Pool, originals: readonly string[]): Promise<IdentityMapping[]>;
/** Native structural tuple. Generation/pending remain Semantic's identity authority. */
export type HomeIdentity = Readonly<{
    partition: number;
    epoch: number;
    home: string;
    generation: bigint;
    pending: bigint;
}>;
export type IdentityBasis = Readonly<{
    digest: string;
}>;
export type BasisRead = {
    state: 'ready';
    basis: IdentityBasis;
} | {
    state: 'not_ready';
};
export declare function readIdentityHome(client: PoolClient, partition: number): Promise<HomeIdentity>;
/** Two released observations, never an Access decision or promise about subsequent writes. */
export declare function readIdentityBasis(pool: Pool, options: {
    deadline: number;
}): Promise<BasisRead>;
