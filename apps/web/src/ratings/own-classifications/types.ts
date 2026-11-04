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
