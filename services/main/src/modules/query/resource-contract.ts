import { t } from 'elysia';
import type { Static } from 'typebox';
import { listRequestFields, listResponse } from '../../api-list.ts';
import {
  readAvatar,
  readId,
  readName,
  readPosition,
  WORK_READ_COST,
} from '../work/read-contract.ts';
import type { FilterDocument } from '../../../../../model/definitions/filter-document-v1.ts';

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
  href: t.String(),
});
export type ResourceCard = Static<typeof resourceCard>;
export const resourceListPage = t.Object({
  ...listResponse(resourceCard).properties,
  profile: t.Literal('resource-list-v1'),
  sourcePosition: readPosition,
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
  candidates: 65,
  indexDocuments: 64,
  types: 64,
  graphCalls: WORK_READ_COST.graphCalls,
  deadlineMs: WORK_READ_COST.deadlineMs,
  graphBytes: WORK_READ_COST.graphBytes,
} as const;
