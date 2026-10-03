import { t } from 'elysia';
import type { Static } from 'typebox';
import { listRequestFields, listResponse } from '../../api-list.ts';
import {
  readAvatar,
  readId,
  readName,
  readPosition,
  creditItem,
  WORK_READ_COST,
} from '../work/read-contract.ts';
import type { FilterDocument } from '../../../../../model/definitions/filter-document-v1.ts';
import { discoveryCredit, discoveryRating } from '../discovery/contract.ts';

/** Page-only hydration of projected previews, never live credit or rating aggregation. */
export const RESOURCE_WORK_CARD_COST = { works: 64, credits: 3, projectionQueries: 1,
  projectionBytes: 256 * 1024, agentMentions: 192, ratingSummaries: 64 } as const;
export const resourceWorkCard = t.Object({
  primaryCredits: t.Array(discoveryCredit, { maxItems: RESOURCE_WORK_CARD_COST.credits }),
  creditCount: t.Object({ value: t.Integer({ minimum: 0 }),
    kind: t.Union([t.Literal('exact'), t.Literal('at-least')]) }),
  rating: t.Nullable(discoveryRating),
});
export type ResourceWorkCard = Static<typeof resourceWorkCard>;
export const resourceProjectedCard = t.Object({
  primaryCredits: t.Array(t.Union([creditItem, t.Object({
    id: readId, role: t.Literal('author'), participantKind: t.Literal('agent'),
    provider: t.Null(), key: t.Null(), ordinal: t.Null(), agent: readId,
    displayName: t.Nullable(t.String({ minLength: 1, maxLength: 200 })), handle: t.Nullable(t.String()),
  })]), { maxItems: RESOURCE_WORK_CARD_COST.credits }),
  rating: t.Nullable(discoveryRating),
});

/** Versioned addition to /v1/query. Earlier filter-document profiles retain their meaning. */
export const resourceListQuery = t.Object(
  {
    profile: t.Literal('resource-list-v1'),
    ...listRequestFields,
    context: t.Union([
      t.Literal('global'),
      t.Object({ realm: readId }, { additionalProperties: false }),
    ]),
    scope: t.Union([
      t.Object({ kind: t.Literal('all') }, { additionalProperties: false }),
      t.Object({ kind: t.Literal('realm'), realm: readId }, { additionalProperties: false }),
    ]),
    filter: t.Optional(t.Unknown()),
    sort: t.Union([t.Literal('relevance'), t.Literal('newest'), t.Literal('updated')]),
  },
  { additionalProperties: false },
);
export type ResourceListQuery = Omit<Static<typeof resourceListQuery>, 'filter'> & {
  filter?: FilterDocument;
};
export const resourceCard = t.Object({
  id: readId,
  types: t.Array(t.String(), { maxItems: 64 }),
  kind: t.Union([
    t.Literal('work'),
    t.Literal('space'),
    t.Literal('realm'),
    t.Literal('site'),
    t.Literal('agent'),
    t.Literal('collection'),
    t.Literal('concept'),
  ]),
  name: readName,
  icon: readAvatar,
  work: t.Optional(resourceWorkCard),
});
export type ResourceCard = Static<typeof resourceCard>;
export const resourceListPage = t.Object({
  ...listResponse(resourceCard).properties,
  profile: t.Literal('resource-list-v1'),
  sourcePosition: readPosition,
  stale: t.Boolean(),
});
export interface ResourceCondition {
  facet: 'type' | 'concept' | 'language';
  operator: 'any' | 'all' | 'none';
  values: string[];
}
export interface ResourceListPlan {
  input: ResourceListQuery;
  conditions: ResourceCondition[];
}
/** Native ranked reads retain 64 hits; graph pages retain 64+1 candidates.
 * Disclosure can shorten a page; the cursor advances over examined candidates.
 * A single-owner type selection enters the native collector before retrieval.
 * Each ranked window needs one live population join and zero per-hit text
 * collectors. Concept meaning needs one graph read per request, independent of
 * refill count. Names/types/disclosure admit the full 64-candidate window once;
 * credit/rating previews cover only the remaining page slots. An undecided
 * hit stays after the cursor. Application matching is O(C*T*I + M), with C
 * examined candidates, T selected Concepts, I interpretations and M membership
 * rows, rather than rescanning the whole membership relation for every chip.
 * Ordered Work seeks drive the smallest positive Concept group, merging at
 * most 8*(64+1) indexed posting rows per window. Exclusion-only requests seek
 * the wildcard Work list and perform bounded primary-key membership probes.
 * A fresh type/positive-topic posting set is probed for at most 65 keys. Only a complete set
 * of <=64 keys constrains ranked retrieval; larger/stale sets retain its
 * existing continuation, never the ranking of a recent sample.
 * No global result-size cap and no OFFSET. Native searchAfter still evaluates
 * matching postings; bounded HTTP rows do not establish bounded engine work.
 * https://lucene.apache.org/core/10_3_1/core/org/apache/lucene/search/IndexSearcher.html
 * Negation and other low-selectivity joins can return advancing partial pages.
 * The enclosing WorkReadSession enforces time, calls and bytes. */
export const RESOURCE_LIST_COST = {
  candidates: 512,
  indexDocuments: 512,
  window: 64,
  types: 64,
  rankedJoinsPerWindow: 1,
  rankedCandidateTextRechecks: 0,
  conceptResolutionReads: 1,
  graphCalls: WORK_READ_COST.graphCalls,
  deadlineMs: WORK_READ_COST.deadlineMs,
  graphBytes: WORK_READ_COST.graphBytes,
} as const;
