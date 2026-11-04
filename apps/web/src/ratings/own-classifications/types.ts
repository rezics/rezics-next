import type { KernelClient } from '@rezics/client';

/** Successful page shape from the admitted mounted Client output. */
export type OwnClassificationsPage = NonNullable<
  Awaited<ReturnType<KernelClient['me']['classification-assessments']['get']>>['data']
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

export type OwnClassificationsRead = Readonly<{
  state: Exclude<OwnClassificationsState, 'ready'>;
  page: null;
  subject: string | null;
  locale: string;
  frontier: ClassificationFrontier | null;
}> | Readonly<{
  state: 'ready';
  page: OwnClassificationsPage;
  subject: string;
  locale: string;
  frontier: ClassificationFrontier;
  source: 'content.classification-ballot-own-page.v1';
  credential: string;
  observation: string;
}>;

type SubjectClient = ReturnType<KernelClient['subjects']>;
type AssociationClient = ReturnType<SubjectClient['classification-associations']>;
export type ClassificationOwnState = NonNullable<Awaited<ReturnType<AssociationClient['assessment']['get']>>['data']>;
export type ClassificationSetBody = Parameters<AssociationClient['assessment']['put']>[0];
export type ClassificationCommandResult = { kind: 'acknowledged' | 'uncertain' | 'stale' | 'denied' };
export type ClassificationReview = { kind: 'current'; own: ClassificationOwnState } | { kind: 'unavailable' };
