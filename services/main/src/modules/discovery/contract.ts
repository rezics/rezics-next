import { t } from 'elysia';
import type { Static } from 'typebox';
import {
  creditItem,
  pageFields,
  pageQuery,
  readId,
  readName,
  readPosition,
  readScope,
  readUuid,
  scopeQuery,
  workCard,
} from '../work/read-contract.ts';
import '../types/registry.ts';
import { registryWorkType } from '../types/contract.ts';
import { canonicalAddress } from '../address/schema.ts';

/** Per GET: one B-tree seek + P+1 projected candidates, two Work summary batches,
 * up to two Concept summary batches and graph/Access position fences. Build work
 * happens only in bounded management or scheduler steps.
 * Native graph enumeration during builds is separately bounded by the Work read
 * envelope; it is not claimed to have the PostgreSQL seek complexity. */
export const DISCOVERY_COST = {
  pageSize: 20,
  buildWorks: 250,
  termsPerWork: 20,
  cardTags: 3,
  primaryCredits: 3,
  entriesPerWork: 84,
  projectionBytes: 256 * 1024,
  leaseMs: 30_000,
} as const;
export const discoveryType = registryWorkType;
export const discoveryQuery = t.Object(
  {
    ...pageQuery,
    ...scopeQuery,
    sort: t.Optional(t.Union([t.Literal('recent'), t.Literal('top-rated')])),
    type: t.Optional(discoveryType),
    term: t.Optional(readId),
    context: t.Optional(readId),
  },
  { additionalProperties: false },
);
export const discoveryBasis = t.Object(
  { scope: readScope.properties.kind, realm: t.Nullable(readId), context: t.Nullable(readId) },
  { additionalProperties: false },
);
export type DiscoveryBasis = Static<typeof discoveryBasis>;
export type DiscoveryQuery = Static<typeof discoveryQuery>;
export interface OwnedDiscoveryBasis extends DiscoveryBasis {
  owner: string | null;
}
export const classificationReason = t.Object({
  sense: readId,
  concept: readId,
  decision: t.String(),
  source: t.Union([t.Literal('local'), t.Literal('global')]),
});
export const discoveryTag = t.Object({ ...classificationReason.properties, name: readName });
export const discoveryRating = t.Object({
  context: readId,
  count: t.Integer({ minimum: 1, maximum: 100 }),
  sum: t.Integer(),
  mean: t.Number(),
  scale: t.Object({ min: t.Literal(1), max: t.Union([t.Literal(5), t.Literal(10)]) }),
});
export const discoveryCredit = t.Union([
  creditItem,
  t.Object({
    id: readId,
    role: t.Literal('author'),
    participantKind: t.Literal('agent'),
    provider: t.Null(),
    key: t.Null(),
    ordinal: t.Null(),
    agent: readId,
    displayName: t.String({ minLength: 1, maxLength: 200 }),
    handle: t.Nullable(t.String({ minLength: 1, maxLength: 30 })),
    address: t.Optional(canonicalAddress),
  }),
]);
export type DiscoveryCredit = Static<typeof discoveryCredit>;

/** A card names an author Agent. Other roles stay on the credit read. */
export function namedAuthorCredit(
  credit: { id: string; role: string; agent: string | null },
  name: { displayName: string; handle: string | null; address?: Static<typeof canonicalAddress> },
): DiscoveryCredit | undefined {
  if (credit.role !== 'author' || !credit.agent) return undefined;
  return {
    id: credit.id, role: 'author', participantKind: 'agent', provider: null, key: null, ordinal: null,
    agent: credit.agent, displayName: name.displayName, handle: name.handle,
    ...(name.address ? { address: name.address } : {}),
  };
}
export type ProjectedCredit =
  | Static<typeof creditItem>
  | {
      id: string;
      role: 'author';
      participantKind: 'agent';
      provider: null;
      key: null;
      ordinal: null;
      agent: string;
      displayName: null;
      handle: null;
    };
export const discoveryItem = t.Object({
  ...workCard.properties,
  unavailablePreviews: t.Optional(
    t.Array(t.Union([t.Literal('serial'), t.Literal('credits'), t.Literal('rating')]), {
      maxItems: 3,
    }),
  ),
  primaryCredits: t.Array(discoveryCredit, { maxItems: DISCOVERY_COST.primaryCredits }),
  classifications: t.Array(discoveryTag, { maxItems: DISCOVERY_COST.cardTags }),
  rating: t.Nullable(discoveryRating),
  match: t.Object({
    publication: t.Literal('public-main'),
    type: t.Nullable(t.String()),
    classification: t.Nullable(discoveryTag),
  }),
});
export const discoveryPage = t.Object({
  profile: t.Literal('discovery-works-v1'),
  generation: readUuid,
  stale: t.Boolean(),
  projectionPosition: readPosition,
  order: t.Union([t.Literal('recent'), t.Literal('top-rated')]),
  scope: readScope,
  context: t.Nullable(readId),
  matchedTerm: t.Nullable(discoveryTag),
  items: t.Array(discoveryItem, { maxItems: DISCOVERY_COST.pageSize }),
  ...pageFields,
  matches: t.Object({
    value: t.Integer({ minimum: 0 }),
    kind: t.Union([t.Literal('exact'), t.Literal('lower-bound')]),
  }),
});
export const popularTermsQuery = t.Object(
  {
    language: pageQuery.language,
    scope: t.Optional(t.Union([t.Literal('global'), t.Literal('realm')])),
    realm: t.Optional(readId),
    context: t.Optional(readId),
    limit: pageQuery.limit,
  },
  { additionalProperties: false },
);
export type PopularTermsQuery = Static<typeof popularTermsQuery>;
export const popularTermsPage = t.Object({
  profile: t.Literal('discovery-popular-terms-v1'),
  generation: readUuid,
  stale: t.Boolean(),
  projectionPosition: readPosition,
  scope: readScope,
  sourcePosition: t.Object({ dataEpoch: t.String(), sequence: t.String() }),
  items: t.Array(
    t.Object({
      sense: readId,
      concept: readId,
      name: readName,
      workCount: t.Integer({ minimum: 1 }),
    }),
    { maxItems: DISCOVERY_COST.pageSize },
  ),
});
export interface ProjectedWork {
  work: string;
  revision: string;
  mainVersion: string;
  types: string[];
  recentOrder: string;
  rating: Static<typeof discoveryRating> | null;
  primaryCredits: ProjectedCredit[];
  classifications: Static<typeof classificationReason>[];
}
export interface DiscoveryPayload {
  revision: string;
  mainVersion: string;
  types: string[];
  primaryCredits: ProjectedCredit[];
  classifications: Static<typeof classificationReason>[];
  rating: Static<typeof discoveryRating> | null;
  classification: Static<typeof classificationReason> | null;
}
export interface DiscoveryRow {
  work: string;
  order_key: string;
  payload: DiscoveryPayload;
}
