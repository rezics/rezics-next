import type { RatingReviewPort } from '../contract/domain-ports.ts';
import { type IdentityMappingRequest, type IdentityRatingNativeEvidence, type IdentityRatingReviewResult } from '../identity-core/index.ts';
export type RatingReviewApplication = Readonly<{
    classify(requestedOriginalId: string, canonicalTerminalId: string, sourceIdentities: readonly string[], sourceHomes: readonly number[], evidence: IdentityRatingNativeEvidence, mappingRequests: readonly IdentityMappingRequest[]): IdentityRatingReviewResult;
    evidence(value: IdentityRatingNativeEvidence): string;
    throwFor(result: Exclude<IdentityRatingReviewResult, {
        state: 'reviewed';
    }>): never;
}>;
/** Rating-owned errors are constructed by the injected port; this use case never imports Rating. */
export declare function createRatingReviewApplication(port: RatingReviewPort): RatingReviewApplication;
