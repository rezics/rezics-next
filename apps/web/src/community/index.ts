/** Public visit composition: applications consume capabilities; route/session hosts bind their real producers. */
export { SpacePage, RealmShelf } from './space-page';
export type {
  CommunityVisitApplication,
  CommunitySession,
  CommunityRealmReading,
  RealmShelfTransport,
} from './contract/visit';
export { createCommunityReading } from './adapters/visit-reading';
export type { NativeRealmHomeOperations } from './realm-home-native';
export type { SpacePageData, RealmHome, PublishedSubject } from './space';
export type { RealmPublicationCompletion } from './realm-community/completion';
export { AuthoringDepartureBoundary } from '../threads/authoring-departure';
export { spaceQuery, realmPageQuery } from './space-queries';
export { spacePageHead } from './space-head';
export {
  awaitSpacePageRead,
  bindHydratedSpacePage,
  captureSpacePageAdmission,
  isObsoleteSpacePageRead,
  ObsoleteSpacePageReadError,
  releaseSpacePageRead,
  spacePageAdmissionFor,
  spacePageQueryResultIsCurrent,
  spacePageReadWasCancelled,
  spacePageReadResultWasReplaced,
  spacePageSessionSource,
  SpacePageLifetimeHost,
} from './space-page-lifetime';
export type { SpacePageAdmission, SpacePageTarget } from './space-page-lifetime';
export { CommunityResourceAccess } from './adapters/resource-access';
