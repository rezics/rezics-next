import type { Static } from 'typebox';

/** Source contract only. This does not declare an installed Client operation. */
export type OwnClassificationsPage = Static<
  typeof import('../../../../../services/kernel/src/rating/classification-ballot-own-page-schemas.ts').ClassificationBallotOwnPageSchema
>;
export type OwnClassification = OwnClassificationsPage['items'][number];
export type ClassificationKey = Readonly<{ subjectId: string; associationId: string }>;
export type ClassificationFrontier = Readonly<{
  cursor: string | null;
  selected: ClassificationKey | null;
}>;
export type OwnClassificationsState =
  | 'ready'
  | 'preparing'
  | 'signed-out'
  | 'denied'
  | 'unavailable'
  | 'invalid-address'
  | 'stale-continuation'
  | 'moved-home';
