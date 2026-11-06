import type { RatingReviewPort } from '../contract/domain-ports.ts';
import {
  classifyIdentityRatingReviewEvidence,
  identityRatingReviewEvidence,
  type IdentityMappingRequest,
  type IdentityRatingNativeEvidence,
  type IdentityRatingReviewResult,
} from '../identity-core/index.ts';

export type RatingReviewApplication = Readonly<{
  classify(
    requestedOriginalId: string,
    canonicalTerminalId: string,
    sourceIdentities: readonly string[],
    sourceHomes: readonly number[],
    evidence: IdentityRatingNativeEvidence,
    mappingRequests: readonly IdentityMappingRequest[],
  ): IdentityRatingReviewResult;
  evidence(value: IdentityRatingNativeEvidence): string;
  throwFor(result: Exclude<IdentityRatingReviewResult, { state: 'reviewed' }>): never;
}>;

/** Rating-owned errors are constructed by the injected port; this use case never imports Rating. */
export function createRatingReviewApplication(port: RatingReviewPort): RatingReviewApplication {
  return Object.freeze({
    classify: classifyIdentityRatingReviewEvidence,
    evidence: identityRatingReviewEvidence,
    throwFor(result) {
      if (result.state === 'pending') throw port.pending();
      if (result.state === 'moved') throw port.moved(result.home);
      if (result.state === 'absent') throw port.absent();
      if (result.state === 'undisclosed') throw port.undisclosed();
      if (result.state === 'changed') throw port.subjectChanged();
      throw port.unavailable();
    },
  });
}
