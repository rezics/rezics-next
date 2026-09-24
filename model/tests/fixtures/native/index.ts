import { classificationContextFixture } from './classification-context.ts';
import { classificationDirectDecisionFixture } from './classification-direct-decision.ts';
import { classificationPropositionFixture } from './classification-proposition.ts';
import { mainDefaultSelectionFixture } from './main-default-selection.ts';
import { realmLocalRejectionFixture } from './realm-local-rejection.ts';
import { realmLocalSelectionFixture } from './realm-local-selection.ts';
import { realmStandingRatingContextFixture } from './realm-standing-rating-context.ts';
import { realmStandingRatingObservationFixture } from './realm-standing-rating-observation.ts';
import { spaceRealmFixture } from './space-realm.ts';
import { textContributionFixture } from './text-contribution.ts';
import { textPublicationFixture } from './text-publication.ts';
import { workMetadataFixture } from './work-metadata.ts';

export const nativeFixtures = [
  classificationContextFixture,
  classificationDirectDecisionFixture,
  classificationPropositionFixture,
  mainDefaultSelectionFixture,
  realmLocalRejectionFixture,
  realmLocalSelectionFixture,
  realmStandingRatingContextFixture,
  realmStandingRatingObservationFixture,
  spaceRealmFixture,
  textContributionFixture,
  textPublicationFixture,
  workMetadataFixture
] as const;
