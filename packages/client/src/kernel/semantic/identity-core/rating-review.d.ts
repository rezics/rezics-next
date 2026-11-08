import { type IdentityMappingEvidence, type IdentityMappingRequest } from './mapping.ts';
export { IDENTITY_RATING_REVIEW_MAX_CONTROL_LOCATORS, IDENTITY_RATING_REVIEW_MAX_KEYS, IDENTITY_RATING_REVIEW_MAX_OPERAND_BYTES, } from './rating-review-bounds.ts';
import type { IdentityRatingControlLocator, IdentityRatingReviewResult } from '../contract/index.ts';
export type { IdentityRatingControlLocator, IdentityRatingReviewOperand, IdentityRatingReviewUnavailableReason, IdentityRatingReviewResult, } from '../contract/index.ts';
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
