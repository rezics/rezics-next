import { t } from 'elysia';
import type { Static } from 'typebox';
import { sourcePosition } from '../../api-contract.ts';
import type { SemanticValue } from '../semantic/value.ts';
import { EXACT_LIMITS } from '../semantic/value.ts';
import { readLanguage } from '../work/read-contract.ts';
import { templatePaging, templatePresentation } from './template-schema.ts';

export const ASSOCIATION_QUERY = 'https://rezics.com/query/subject-associations';
export const ASSOCIATION_COST = { candidates: 256, witnesses: 64, participations: 64,
  predicates: 16, frames: 8, citations: 16, cursor: 2048 } as const;
const closed = { additionalProperties: false } as const;
const id = t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' });
const slug = t.String({ pattern: '^[a-z0-9]+(-[a-z0-9]+)*$', maxLength: 64 });
const iri = t.String({ pattern: '^https?://[^\\s<>"{}|\\\\^`]+$', maxLength: 2048 });
const key = t.String({ minLength: 1, maxLength: EXACT_LIMITS.key, pattern: '^[^\\u0000-\\u001f\\u007f]+$' });
const exactLanguage = t.String({ minLength: 2, maxLength: 35 });
const resource = t.Object({ kind: t.Literal('resource'), ref: id }, closed);
const external = t.Object({ kind: t.Literal('external'), provider: slug, namespace: slug, key }, closed);
export const associationParticipant = t.Union([resource, external]);
const numberLexical = t.String({ minLength: 1, maxLength: EXACT_LIMITS.digits + 2 });
const exactNumber = t.Union([
  t.Object({ kind: t.Literal('integer'), lexical: numberLexical }, closed),
  t.Object({ kind: t.Literal('decimal'), lexical: numberLexical }, closed),
  t.Object({ kind: t.Literal('rational'), lexical: numberLexical }, closed),
]);
// Transport alternatives use the exact Value owner's codec during admission;
// JSON schema alone cannot prove canonical rational/temporal/quantity meaning.
export const associationValue = t.Unsafe<SemanticValue>(t.Union([
  exactNumber, resource, external,
  t.Object({ kind: t.Literal('boolean'), lexical: t.Union([t.Literal('true'), t.Literal('false')]) }, closed),
  t.Object({ kind: t.Literal('string'), lexical: t.String({ maxLength: EXACT_LIMITS.text }) }, closed),
  t.Object({ kind: t.Literal('language-string'), lexical: t.String({ maxLength: EXACT_LIMITS.text }),
    language: exactLanguage, direction: t.Optional(t.Union([t.Literal('ltr'), t.Literal('rtl')])) }, closed),
  t.Object({ kind: t.Literal('temporal'), lexical: t.String({ minLength: 1, maxLength: 64 }),
    precision: t.Union([t.Literal('year'), t.Literal('month'), t.Literal('day'), t.Literal('hour'),
      t.Literal('minute'), t.Literal('second')]), calendar: t.Literal('gregorian'),
    timeZone: t.Optional(t.String({ maxLength: 64 })) }, closed),
  t.Object({ kind: t.Literal('quantity'), lexical: numberLexical, value: exactNumber, unit: iri,
    quantityKind: t.Optional(iri), uncertainty: t.Optional(exactNumber) }, closed),
  t.Object({ kind: t.Literal('unknown') }, closed), t.Object({ kind: t.Literal('no-value') }, closed),
]));
export const associationContext = t.Union([t.Literal('global'), t.Object({ realm: id }, closed)]);
export const associationSnapshot = t.Object({ sourcePosition: t.Object(sourcePosition.properties, closed),
  modelGeneration: t.String({ minLength: 1 }) }, closed);
const predicate = t.Object({ predicate: id, value: associationValue }, closed);
const predicates = t.Array(predicate, { maxItems: ASSOCIATION_COST.predicates, uniqueItems: true });
export const associationRequest = t.Object({ profile: t.Literal('template-query-v1'),
  query: t.Literal(ASSOCIATION_QUERY), revision: t.Literal(1), parameters: t.Object({
    kind: t.Union([t.Literal('appearance'), t.Literal('credit')]),
    direction: t.Union([t.Literal('work-to-subject'), t.Literal('subject-to-work')]),
    roots: t.Optional(t.Array(associationParticipant, { minItems: 1, maxItems: 64, uniqueItems: true })),
    projection: t.Union([t.Literal('work'), t.Literal('occurrence')]), context: associationContext,
    frame: t.Array(id, { maxItems: ASSOCIATION_COST.frames, uniqueItems: true }),
    position: t.Union([t.Literal('start'), t.Literal('all'), id]),
    match: t.Object({ role: t.Optional(t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/role/[a-z][a-z0-9-]{0,31}$', maxLength: 200 })),
      all: predicates, any: predicates, none: predicates }, closed), snapshot: t.Optional(associationSnapshot),
  }, closed), presentation: t.Optional(templatePresentation), ...templatePaging }, closed);

const qualification = t.Union([t.Literal('asserted'), t.Literal('uncertain'), t.Literal('conflicting')]);
export const associationCitation = t.Object({ id, sourceWork: id,
  representationSha256: t.String({ pattern: '^[a-f0-9]{64}$' }), locator: t.Unknown(),
  quote: t.Nullable(t.String()), quoteWithheld: t.Boolean(), method: t.Unknown(),
  modality: t.String(), submitter: id, rightsBasis: t.String() }, closed);
const citations = t.Array(associationCitation, { minItems: 1, maxItems: ASSOCIATION_COST.citations });
const nullableAttribution = t.Nullable(t.String({ minLength: 1, maxLength: 200 }));
const participation = t.Object({ id, role: iri, participant: associationParticipant,
  position: t.Optional(t.Integer({ minimum: 0, maximum: 1023 })),
  creditedName: t.Optional(t.Object({ lexical: t.String({ minLength: 1, maxLength: 200 }), language: readLanguage }, closed)),
  sourceIdentity: t.Optional(t.Object({ provider: slug, namespace: slug, key: t.String({ minLength: 1, maxLength: 200 }),
    alias: nullableAttribution, eid: nullableAttribution, note: t.Nullable(t.String({ maxLength: 2000 })) }, closed)),
}, closed);
export const associationStatement = t.Object({ id, revision: id, subject: associationParticipant,
  predicate: id, value: associationValue, occurrence: t.Nullable(id), context: associationContext,
  applicability: t.Array(id, { maxItems: ASSOCIATION_COST.frames, uniqueItems: true }), qualification,
  decisionRevision: id, citations }, closed);
export const associationWitness = t.Object({ kind: t.Union([t.Literal('appearance'), t.Literal('credit')]),
  work: id, occurrence: id, revision: id, definition: id, workParticipation: id, subjectParticipation: id,
  subject: associationParticipant, role: iri, context: associationContext,
  applicability: t.Array(id, { maxItems: ASSOCIATION_COST.frames, uniqueItems: true }), qualification,
  participations: t.Array(participation, { minItems: 2, maxItems: ASSOCIATION_COST.participations }),
  statements: t.Array(associationStatement, { maxItems: 512 }), citations,
  sourceVersionStatus: t.Union([t.Literal('exact'), t.Literal('unresolved')]),
  labels: t.Object({ subject: t.Nullable(t.String()), role: t.Nullable(t.String()), work: t.Nullable(t.String()) }, closed),
  snippets: t.Array(t.String()), links: t.Array(t.Object({ rel: t.String(),
    method: t.Union([t.Literal('GET'), t.Literal('POST')]), href: t.String(), body: t.Optional(t.Unknown()) }, closed)),
}, closed);
const continuation = { nextCursor: t.Nullable(t.String({ minLength: 1, maxLength: ASSOCIATION_COST.cursor })), complete: t.Boolean() };
export const associationWorkMatch = t.Object({ work: id, matches: t.Object({
  items: t.Array(associationWitness, { minItems: 1, maxItems: ASSOCIATION_COST.witnesses }), ...continuation,
}, closed) }, closed);
export const associationResult = t.Object({ profile: t.Literal('template-result-v1'), query: t.Literal(ASSOCIATION_QUERY),
  revision: t.Literal(1), ...associationSnapshot.properties,
  items: t.Array(t.Union([associationWitness, associationWorkMatch]), { maxItems: 64 }), ...continuation,
  count: t.Object({ value: t.Integer({ minimum: 0, maximum: 64 }), kind: t.Literal('exact-page'), total: t.Null() }, closed),
}, closed);
export type AssociationRequest = Static<typeof associationRequest>;
export type AssociationSelection = Omit<AssociationRequest, 'cursor' | 'limit' | 'presentation'> & {
  limit: number; presentation: { language: string; actingSubject?: string };
};
export type AssociationSnapshot = Static<typeof associationSnapshot>;
export type AssociationWitness = Static<typeof associationWitness>;
export type AssociationStatement = Static<typeof associationStatement>;
export type AssociationWorkMatch = Static<typeof associationWorkMatch>;
export type AssociationResult = Static<typeof associationResult>;
