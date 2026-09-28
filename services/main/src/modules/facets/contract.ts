import { t } from 'elysia';
import { facetLocales } from '../../../../../packages/model/src/generated/facets.ts';

const iri = t.String({ minLength: 1, maxLength: 2048 });
const label = t.String({ minLength: 1, maxLength: 40 });
const closed = { additionalProperties: false } as const;

/** Which values a Condition may name: Resources of a class, Concepts, literals, source identities,
 * role IRIs of the bound relation, or exact DefinitionRefs. */
const facetValueDomain = t.Union([
  t.Object({ kind: t.Literal('class'), class: iri }, closed),
  t.Object({ kind: t.Literal('concept'), scheme: t.Optional(iri) }, closed),
  t.Object({ kind: t.Literal('datatype'), datatype: iri, pattern: t.Optional(t.String()),
    min: t.Optional(t.String()), max: t.Optional(t.String()) }, closed),
  t.Object({ kind: t.Literal('external'), provider: t.String(), namespace: t.String() }, closed),
  t.Object({ kind: t.Literal('role') }, closed),
  t.Object({ kind: t.Literal('definition') }, closed),
]);

/** One step of a Facet's path; `model/compiler/facet.ts` defines each kind. */
const facetStep = t.Union([
  t.Object({ kind: t.Literal('triple'), predicate: iri, inverse: t.Optional(t.Literal(true)),
    graph: t.Optional(t.Literal('revisions')), types: t.Optional(t.Array(iri, { minItems: 1 })) }, closed),
  t.Object({ kind: t.Literal('selection') }, closed),
  t.Object({ kind: t.Literal('credit'), role: t.String() }, closed),
  t.Object({ kind: t.Literal('statement'), predicate: t.Optional(iri), relation: t.Optional(iri) }, closed),
  t.Object({ kind: t.Literal('occurrence') }, closed),
  t.Object({ kind: t.Literal('rating'), target: iri, cadence: iri, population: iri, aggregation: iri,
    scale: t.Object({ min: t.Integer(), max: t.Integer() }, closed) }, closed),
]);

export const facetDefinition = t.Object({
  /** The Facet's exact DefinitionRef. */
  id: iri,
  name: t.String({ pattern: '^[a-z][a-zA-Z0-9]{0,31}$' }),
  version: t.Integer({ minimum: 1 }),
  /** A name resolves to its current version; superseded versions stay readable by DefinitionRef. */
  current: t.Boolean(),
  labels: t.Object(Object.fromEntries(facetLocales.map(locale => [locale, label])) as
    Record<typeof facetLocales[number], typeof label>, closed),
  appliesTo: t.Union([t.Literal('resource'), t.Literal('participant'), t.Literal('participation')]),
  subject: iri,
  path: t.Array(facetStep, { minItems: 1 }),
  values: t.Array(facetValueDomain, { minItems: 1 }),
  operators: t.Array(t.Union([t.Literal('any'), t.Literal('all'), t.Literal('none'), t.Literal('range')]),
    { minItems: 1 }),
  source: t.Union([t.Literal('global'), t.Literal('context')]),
  parameters: t.Array(t.Object({ key: t.String(), value: facetValueDomain }, closed)),
  qualifiers: t.Array(t.Union([t.Literal('interpretation'), t.Literal('applicability')])),
  occurrence: t.Boolean(),
  cost: t.Object({ maxValues: t.Integer({ minimum: 1 }), graphReads: t.Integer({ minimum: 0 }),
    nested: t.Optional(t.Integer({ minimum: 1 })) }, closed),
  /** SHA-256 of the Facet's meaning; labels and cost are refined without a new version. */
  digest: t.String({ pattern: '^[0-9a-f]{64}$' }),
}, closed);

/** Cost: no graph read; one body per deploy, built and bounded when Main loads. */
export const FACETS_READ_COST = { graphReads: 0, maxFacets: 64, maxBytes: 64 * 1024 } as const;

export const facetList = t.Object({
  profile: t.Literal('facets-v1'),
  /** Changes whenever any admitted Facet does; also the response ETag. */
  digest: t.String({ pattern: '^[0-9a-f]{64}$' }),
  facets: t.Array(facetDefinition, { maxItems: FACETS_READ_COST.maxFacets }),
}, closed);
