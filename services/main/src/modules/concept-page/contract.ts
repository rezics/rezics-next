import { t } from 'elysia';
import type { Static } from 'typebox';
import { discoveryItem, discoveryType } from '../discovery/contract.ts';
import { DISCOVERY_CONDITION_COST } from '../discovery/store.ts';
import { resolveFacet } from '../facets/registry.ts';
import { pageFields, pageQuery, readId, readName, readPosition, readScope, readUuid } from '../work/read-contract.ts';

const facet = resolveFacet('concept');
if (!facet?.values.some(domain => domain.kind === 'concept')) throw new Error('The Concept Facet is not admitted');
/** The free Concept Facet ("Tags"): every Concept a Work's Main Version is classified as. */
export const CONCEPT_FACET = facet.id;

/**
 * A Concept page: one visibility and interpretation read, one bounded read of
 * definitions and broader and narrower Concepts, and one summary batch naming
 * them all (at most 1 + 8 + 20 of 64).
 */
export const CONCEPT_PAGE_COST = { graphQueries: 2, summaryBatches: 1, definitions: 32, broader: 8, narrower: 20,
  interpretations: 4 } as const;
/**
 * Works reaching a Concept, with more values: one visibility read for at most
 * 16 values, one summary batch, one exact count lookup for the included
 * interpretations, and one bounded Condition page of the discovery projection
 * between two generation checks. Values per operator are the Concept Facet's.
 */
export const CONCEPT_WORKS_COST = { pageSize: 20, values: facet.cost.maxValues,
  interpretations: CONCEPT_PAGE_COST.interpretations, countedTerms: 20, graphQueries: 1, summaryBatches: 1,
  window: DISCOVERY_CONDITION_COST.window } as const;

const closed = { additionalProperties: false } as const;
const values = t.Array(readId, { minItems: 1, maxItems: CONCEPT_WORKS_COST.values, uniqueItems: true });
/** A Condition on the Concept Facet, in the FilterDocument grammar (`modules/facets/schema.ts`). */
const conceptCondition = t.Union([t.Object({ facet: t.Literal(CONCEPT_FACET), all: values }, closed),
  t.Object({ facet: t.Literal(CONCEPT_FACET), any: values }, closed),
  t.Object({ facet: t.Literal(CONCEPT_FACET), none: values }, closed)]);
export const conceptFilterDocument = t.Object({ all: t.Array(conceptCondition, { minItems: 1, maxItems: 2 }) }, closed);
export type ConceptFilterDocument = Static<typeof conceptFilterDocument>;

/** The one-Condition Filter a Concept's page lists and a follow of the Concept follows. */
export const conceptFilter = (concept: string): ConceptFilterDocument =>
  ({ all: [{ facet: CONCEPT_FACET, any: [concept] }] });

/** Included values match all or any; the page's Concept is always the first included. */
export function conceptWorksFilter(concept: string, include: readonly string[], exclude: readonly string[],
  match: 'all' | 'any'): ConceptFilterDocument {
  const included = [concept, ...include];
  return { all: [match === 'all' ? { facet: CONCEPT_FACET, all: included } : { facet: CONCEPT_FACET, any: included },
    ...exclude.length ? [{ facet: CONCEPT_FACET, none: [...exclude] }] : []] };
}

const conceptLink = t.Object({ id: readId, name: readName });
export const conceptPage = t.Object({ profile: t.Literal('concept-v1'), id: readId, name: readName,
  /** `skos:definition` in the requested language when the Concept has one. */
  description: t.Nullable(readName),
  /** The Realm a local Concept belongs to; null for a Global one. */
  realm: t.Nullable(readId),
  /** The Facet through which Works reach the Concept, which names its kind of value ("Tags"). */
  facet: t.Literal(CONCEPT_FACET),
  /** Exact interpretations Works are classified under; a phrase search narrows by one of them. */
  interpretations: t.Array(readId, { maxItems: CONCEPT_PAGE_COST.interpretations }),
  broader: t.Array(conceptLink, { maxItems: CONCEPT_PAGE_COST.broader }),
  narrower: t.Array(conceptLink, { maxItems: CONCEPT_PAGE_COST.narrower }),
  /** More narrower Concepts exist than are listed. */
  moreNarrower: t.Boolean(),
  filter: conceptFilterDocument, sourcePosition: readPosition }, closed);

const { actingSubject: _reader, ...publicPage } = pageQuery;
export const conceptWorksQuery = t.Object({ ...publicPage,
  scope: t.Optional(t.Union([t.Literal('global'), t.Literal('realm')])), realm: t.Optional(readId),
  /** More Concepts a Work must carry, all or any of them with the page's. */
  include: t.Optional(t.Array(readId, { minItems: 1, maxItems: CONCEPT_WORKS_COST.values - 1, uniqueItems: true })),
  /** Concepts no listed Work carries. */
  exclude: t.Optional(values),
  match: t.Optional(t.Union([t.Literal('all'), t.Literal('any')])),
  type: t.Optional(discoveryType) }, closed);
export type ConceptWorksQuery = Static<typeof conceptWorksQuery>;

export const conceptWorksPage = t.Object({ profile: t.Literal('concept-works-v1'), concept: readId,
  scope: readScope, match: t.Union([t.Literal('all'), t.Literal('any')]), filter: conceptFilterDocument,
  /** Every value in the Filter, named for its Condition bar: the included first, the page's leading. */
  values: t.Array(t.Object({ id: readId, name: readName,
    operator: t.Union([t.Literal('include'), t.Literal('exclude')]) }), { maxItems: 2 * CONCEPT_WORKS_COST.values }),
  generation: readUuid, stale: t.Boolean(), projectionPosition: readPosition,
  items: t.Array(discoveryItem, { maxItems: CONCEPT_WORKS_COST.pageSize }), ...pageFields,
  matches: t.Object({ value: t.Integer({ minimum: 0 }),
    kind: t.Union([t.Literal('exact'), t.Literal('lower-bound')]) }) });
