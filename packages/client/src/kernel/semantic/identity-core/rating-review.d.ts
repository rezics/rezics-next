import { type IdentityMappingEvidence, type IdentityMappingRequest } from './mapping.ts';
export { IDENTITY_RATING_REVIEW_MAX_CONTROL_LOCATORS, IDENTITY_RATING_REVIEW_MAX_KEYS, IDENTITY_RATING_REVIEW_MAX_OPERAND_BYTES, } from './rating-review-bounds.ts';
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
export type IdentityRatingSubjectDisclosure = Readonly<{
    subject_id: string;
    visibility: string;
}>;
export type IdentityRatingNativeEvidence = Readonly<{
    mapping: IdentityMappingEvidence;
    subjects: readonly IdentityRatingSubjectDisclosure[];
    controlLocators: readonly IdentityRatingControlLocator[];
}>;
export declare function identityRatingReviewEvidence(value: IdentityRatingNativeEvidence): string;
/** Classifies acquired mapping and disclosure evidence; never acquires facts or native authority. */
export declare function classifyIdentityRatingReviewEvidence(requestedOriginalId: string, canonicalTerminalId: string, sourceIdentities: readonly string[], sourceHomes: readonly number[], evidence: IdentityRatingNativeEvidence, mappingRequests: readonly IdentityMappingRequest[]): IdentityRatingReviewResult;
