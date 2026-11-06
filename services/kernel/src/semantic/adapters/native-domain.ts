import type { Pool } from 'pg';
import type {
  ContentLifecyclePort,
  LibraryCustodyPort,
  RatingReviewPort,
  SearchCurrentnessPort,
} from '../contract/domain-ports.ts';
import type { IdentityEpochParticipantPorts } from '../contract/identity-epoch-ports.ts';
import { createSemanticDomain, type SemanticDomain } from '../application/index.ts';
import { nativeContentLifecycle } from './content-lifecycle.ts';
import { nativeFactStore } from './fact-store.ts';
import { nativeHashing } from './hashing.ts';
import { nativeRatingReview } from './rating-review.ts';
import { nativeRouting } from './routing.ts';

type NativeFactTransaction = Parameters<ReturnType<typeof nativeFactStore>['writeFacts']>[0];
export type NativeSemanticDomain = SemanticDomain<Pool, NativeFactTransaction>;

function custodyFromParticipants(participants: IdentityEpochParticipantPorts<Pool>): LibraryCustodyPort<Pool> {
  return Object.freeze({
    stepIdentityEpoch: participants['library-private-follow-counts'],
    readSourcePage: (native, job) => participants['library-private-follow-counts'](native, job),
  });
}

function searchFromParticipants(participants: IdentityEpochParticipantPorts<Pool>): SearchCurrentnessPort<Pool> {
  return Object.freeze({
    stepCanonicalIndex: participants['search-canonical-index'],
  });
}

/** Bind hashing, routing, facts and the installed identity participants. Cross-domain ports come from composition. */
export function createNativeSemanticDomain(
  participants: IdentityEpochParticipantPorts<Pool>,
  extras: {
    libraryCustody?: LibraryCustodyPort<Pool>;
    searchCurrentness?: SearchCurrentnessPort<Pool>;
    ratingReview?: RatingReviewPort;
    contentLifecycle?: ContentLifecyclePort;
  } = {},
): NativeSemanticDomain {
  return createSemanticDomain<Pool, NativeFactTransaction>({
    version: 1,
    identityEpoch: participants,
    libraryCustody: extras.libraryCustody ?? custodyFromParticipants(participants),
    searchCurrentness: extras.searchCurrentness ?? searchFromParticipants(participants),
    ratingReview: extras.ratingReview ?? nativeRatingReview(),
    contentLifecycle: extras.contentLifecycle ?? nativeContentLifecycle(),
    hashing: nativeHashing(),
    routing: nativeRouting(),
    facts: nativeFactStore(),
  });
}
