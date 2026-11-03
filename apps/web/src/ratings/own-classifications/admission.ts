import { Value } from 'typebox/value';
import { ClassificationBallotOwnPageSchema } from '../../../../../services/kernel/src/rating/classification-ballot-own-page-schemas.ts';
import type { ClassificationFrontier, OwnClassificationsPage } from './types';
import { indexOwnClassifications } from './inventory';

/** Native shape validation only; session, exposure and current observation must separately admit a browser read. */
export function admitOwnClassificationsPage(
  value: unknown,
  accountId: string,
  frontier: ClassificationFrontier,
): OwnClassificationsPage | null {
  if (!Value.Check(ClassificationBallotOwnPageSchema, value)) return null;
  if (value.viewer.accountId !== accountId) return null;
  try {
    if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 1_048_576) return null;
    indexOwnClassifications(value, frontier);
    return value;
  } catch {
    return null;
  }
}
