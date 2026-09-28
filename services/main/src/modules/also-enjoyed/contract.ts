import { t } from 'elysia';
import { discoveryCredit, discoveryRating } from '../discovery/contract.ts';
import { pageFields, pageQuery, workCard } from '../work/read-contract.ts';

export const alsoEnjoyedQuery = t.Object({ ...pageQuery }, { additionalProperties: false });
export const alsoEnjoyedItem = t.Object({ ...workCard.properties,
  primaryCredits: t.Array(discoveryCredit, { maxItems: 3 }),
  rating: t.Nullable(discoveryRating),
  basis: t.Union([t.Literal('co-readers'), t.Literal('similar'), t.Literal('realm')]) });
export const alsoEnjoyedPage = t.Object({ profile: t.Literal('also-enjoyed-v1'),
  items: t.Array(alsoEnjoyedItem, { maxItems: 20 }),
  /** Graph reads crossed sequences, or the derived recommendation basis is behind. */
  stale: t.Boolean(),
  projectionPosition: t.Nullable(pageFields.sourcePosition), ...pageFields });
