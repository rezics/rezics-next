import { t } from 'elysia';
import type { Static } from 'typebox';

/**
 * The feed's legacy `interests` parameter: fixed human kinds that also match
 * Concept labels as strings, which docs/contracts/queries.md rejects.
 * Onboarding now offers Concepts (modules/onboarding); this remains only until
 * the feed and Work type combinations drop the enum.
 */
export const homeInterestKind = t.Union([t.Literal('books'), t.Literal('software'),
  t.Literal('ai'), t.Literal('recipes'), t.Literal('media'), t.Literal('discussions')]);
export type HomeInterestKind = Static<typeof homeInterestKind>;
/** Two bounded reads of at most 120 rows each for eight member Works. */
export const INTEREST_MATCH_COST = { interestRows: 120 } as const;
