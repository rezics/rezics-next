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
 * No global result-size cap and no OFFSET. Graph ordering may sort on disk;
 * the enclosing WorkReadSession enforces time, calls and bytes. */
export const RESOURCE_LIST_COST = {
  candidates: 512,
  indexDocuments: 512,
  window: 64,
  types: 64,
  graphCalls: WORK_READ_COST.graphCalls,
  deadlineMs: WORK_READ_COST.deadlineMs,
  graphBytes: WORK_READ_COST.graphBytes,
} as const;
