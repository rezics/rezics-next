import { identityRatingReviewEvidence, type IdentityMappingEvidence, type IdentityMappingRequest, type IdentityRatingControlLocator, type IdentityRatingNativeEvidence, type IdentityRatingReviewOperand, type IdentityRatingReviewResult, type IdentityRatingReviewUnavailableReason } from '../identity-core/index.ts';
import type { Pool, PoolClient } from 'pg';
import type { CommandTransaction } from '../../command/command.ts';
import type { IdentityNativeReaders, NativeIdentityCapabilities } from '../identity-adapter-port.ts';
import type { IdentityIntent, IdentityMapping } from './identity-epoch-contract.ts';
export type { IdentityRatingControlLocator, IdentityRatingReviewOperand, IdentityRatingReviewResult, IdentityRatingReviewUnavailableReason, IdentityRatingNativeEvidence, };
type Queryable = Readonly<{
    query: (text: string, values?: unknown[]) => Promise<{
        rows: Record<string, unknown>[];
    }>;
}>;
export { identityRatingReviewEvidence };
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
export declare const IDENTITY_RATING_REPAIR_MAX_ORIGINALS = 64;
export type IdentityRepairEvidence = Readonly<{
    state: 'empty';
}> | Readonly<{
    state: 'ready';
    requests: IdentityMappingRequest[];
    evidence: IdentityMappingEvidence;
}> | Readonly<{
    state: 'split';
    foreignHomes: readonly number[];
    local: Readonly<{
        requests: IdentityMappingRequest[];
        evidence: IdentityMappingEvidence;
    }> | null;
}>;
/** Repair evidence on the caller's locked command connection. Up to 64 originals. */
export declare function readIdentityRepairEvidenceInTransaction(client: Queryable, input: Readonly<{
    originals: readonly string[];
    commandHome: number;
}>): Promise<IdentityRepairEvidence>;
/** Pure classifier reused by the transaction participant after it has acquired the native owner fence. */
export declare function classifyIdentityRatingReviewEvidence(requestedOriginalId: string, canonicalTerminalId: string, sourceIdentities: readonly string[], sourceHomes: readonly number[], evidence: IdentityRatingNativeEvidence): IdentityRatingReviewResult;
/** One keyed selection in the captured generation, independent of presentation visibility. */
export declare function selectIdentityEpochRemainder(tx: CommandTransaction, intent: IdentityIntent, input: {
    partition_no: number;
    terminal: string;
    generation: string;
}): Promise<string | null>;
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
/** Mapping, rating-review and basis readers closed over one native read capability. */
export declare function createIdentityReaders(capabilities: NativeIdentityCapabilities): IdentityNativeReaders;
export declare function readIdentityRatingReview(pool: Pool, input: Readonly<{
    requestedOriginalId: string;
    canonicalTerminalId: string;
    deadline: number;
}>): Promise<IdentityRatingReviewResult>;
export declare function readIdentityMappings(pool: Pool, originals: readonly string[]): Promise<IdentityMapping[]>;
export declare function readIdentityBasis(pool: Pool, options: {
    deadline: number;
}): Promise<BasisRead>;
/** One original through the same bounded producer and current native capability set. */
export declare function readIdentityMapping(pool: Pool, original: string): Promise<IdentityMapping>;
