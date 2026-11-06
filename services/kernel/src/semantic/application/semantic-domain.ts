import type { SemanticDomainPorts } from '../contract/domain-ports.ts';
import { createIdentityEpochParticipants } from './identity-epoch-participants.ts';
import { createIdentityCoordination, type IdentityCoordination } from './identity-coordination.ts';
import { createItemApplication, type ItemApplication } from './item-application.ts';
import { createRatingReviewApplication, type RatingReviewApplication } from './rating-review.ts';
import { createSubjectApplication, type SubjectApplication } from './subject-application.ts';

export type SemanticDomain<Native, Tx = unknown> = Readonly<{
  version: 1;
  ports: SemanticDomainPorts<Native, Tx>;
  items: ItemApplication;
  subjects: SubjectApplication<Tx>;
  identity: IdentityCoordination<Native>;
  ratingReview: RatingReviewApplication;
}>;

/** Install the Semantic domain once. Only the named ports are kept; the installed object is frozen. */
export function createSemanticDomain<Native, Tx = unknown>(
  ports: SemanticDomainPorts<Native, Tx>,
): SemanticDomain<Native, Tx> {
  const identityEpoch = createIdentityEpochParticipants(ports.identityEpoch);
  const items = createItemApplication({ hashing: ports.hashing, routing: ports.routing });
  const installed: SemanticDomainPorts<Native, Tx> = Object.freeze({
    version: 1 as const,
    identityEpoch,
    libraryCustody: Object.freeze({
      stepIdentityEpoch: ports.libraryCustody.stepIdentityEpoch,
      readSourcePage: ports.libraryCustody.readSourcePage,
    }),
    searchCurrentness: Object.freeze({
      stepCanonicalIndex: ports.searchCurrentness.stepCanonicalIndex,
    }),
    ratingReview: Object.freeze({
      subjectChanged: ports.ratingReview.subjectChanged,
      identityEpochChanged: ports.ratingReview.identityEpochChanged,
      pending: ports.ratingReview.pending,
      moved: ports.ratingReview.moved,
      absent: ports.ratingReview.absent,
      undisclosed: ports.ratingReview.undisclosed,
      unavailable: ports.ratingReview.unavailable,
      foreignControl: ports.ratingReview.foreignControl,
    }),
    contentLifecycle: Object.freeze({
      checkCover: ports.contentLifecycle.checkCover,
      checkCovers: ports.contentLifecycle.checkCovers,
      importedTupleRoute: ports.contentLifecycle.importedTupleRoute,
    }),
    hashing: Object.freeze({ sha256Hex: ports.hashing.sha256Hex }),
    routing: Object.freeze({
      routeOf: ports.routing.routeOf,
      derivedId: ports.routing.derivedId,
      partitionOf: ports.routing.partitionOf,
    }),
    facts: Object.freeze({
      writeFacts: ports.facts.writeFacts,
      initializeIdentity: ports.facts.initializeIdentity,
    }),
  });
  return Object.freeze({
    version: 1 as const,
    ports: installed,
    items,
    subjects: createSubjectApplication({ items, facts: installed.facts }),
    identity: createIdentityCoordination(identityEpoch),
    ratingReview: createRatingReviewApplication(installed.ratingReview),
  });
}
