import { type IdentityMappingEvidence } from '../identity-core/index.ts';
import type { Pool } from 'pg';
import type { IdentityMapping } from './identity-epoch-contract.ts';
export type IdentityRatingControlLocator = Readonly<{
    partition: number;
    group: string;
}>;
export type IdentityRatingReviewOperand = Readonly<{
    version: 1;
    requestedOriginalId: string;
    canonicalTerminalId: string;
    sourceIdentities: readonly string[];
    sourceHomes: readonly number[];
    controlLocators: readonly IdentityRatingControlLocator[];
    /** Canonical JSON for classifier evidence plus exact subject disclosure states. */
    evidence: string;
}>;
export type IdentityRatingReviewUnavailableReason = 'bootstrap' | 'missing-owner' | 'changed-during-read' | 'control-limit' | 'redirect-chain' | 'canonical-mismatch' | 'operand-too-large';
export type IdentityRatingReviewResult = Readonly<{
    state: 'reviewed';
    operand: IdentityRatingReviewOperand;
}> | Readonly<{
    state: 'pending';
    jobId: string;
    epoch: string;
}> | Readonly<{
    state: 'moved';
    home: number;
}> | Readonly<{
    state: 'changed';
    canonicalTerminalId: string;
}> | Readonly<{
    state: 'absent';
}> | Readonly<{
    state: 'undisclosed';
}> | Readonly<{
    state: 'unavailable';
    reason: IdentityRatingReviewUnavailableReason;
}>;
type SubjectDisclosure = Readonly<{
    subject_id: string;
    visibility: string;
}>;
export type IdentityRatingNativeEvidence = Readonly<{
    mapping: IdentityMappingEvidence;
    subjects: readonly SubjectDisclosure[];
    controlLocators: readonly IdentityRatingControlLocator[];
}>;
type Queryable = Readonly<{
    query: (text: string, values?: unknown[]) => Promise<{
        rows: Record<string, unknown>[];
    }>;
}>;
export declare function identityRatingReviewEvidence(value: IdentityRatingNativeEvidence): string;
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
export {};
