// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 REZICS contributors
import Type, { type Static, type TSchema, type TLiteral } from 'typebox';
import { LocatorSchema, ExternalSourceSchema } from './locator.ts';

export const WIKI_EXTRACTION_PROFILE = 'wiki-extraction-v1' as const;
export const WIKI_EXTRACTION_LIMITS = { units: 256, entities: 128, namesPerEntity: 16,
  claims: 256, evidencePerClaim: 16, namesPerLookup: 64, candidatesPerName: 16,
  textCodePoints: 200, requestBytes: 1_048_576 } as const;
const closed = { additionalProperties: false };
const literal = <T extends string>(value: T) => Type.Literal(value, { maxLength: value.length });
const choice = <T extends string>(values: readonly T[]) => Type.Union(values.map(literal) as [TLiteral<T>, ...TLiteral<T>[]]);
export const WikiIriSchema = Type.String({ minLength: 1, maxLength: 2048,
  pattern: '^https?://[^\\s<>"{}|\\\\^`]+$', 'x-wiki-iri': true });
export const WikiResourceSchema = Type.String({ maxLength: 128,
  pattern: '^https://rezics\\.com/id/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
  'x-wiki-iri': true });
const id = Type.String({ minLength: 1, maxLength: 64, pattern: '^[A-Za-z0-9][A-Za-z0-9_.:-]*$' });
const text = Type.String({ minLength: 1, maxLength: WIKI_EXTRACTION_LIMITS.textCodePoints });
const language = Type.String({ minLength: 1, maxLength: 200 });
const sha256 = Type.String({ minLength: 64, maxLength: 64, pattern: '^[0-9a-f]{64}$' });

/** Keep the general locator compatible. This wire profile narrows every text
 * fallback, script guard and CFI to a passage-sized field. Refinements survive
 * the copy; JSON Schema clients still perform selector/source semantic checks. */
function boundedLocator(schema: TSchema, key = ''): TSchema {
  const source = schema as TSchema & Record<string, unknown>;
  const result: TSchema & Record<string, unknown> = { ...source };
  if (source.type === 'string') {
    const reference = key === 'revision';
    result.maxLength = reference ? 2048 : Math.min(Number(source.maxLength ?? 200), 200);
    if (reference) result['x-wiki-iri'] = true;
  }
  if (source.properties) result.properties = Object.fromEntries(Object.entries(source.properties as Record<string, TSchema>)
    .map(([name, child]) => [name, boundedLocator(name === 'source' ? ExternalSourceSchema : child, name)]));
  for (const union of ['anyOf', 'allOf', 'oneOf'] as const) {
    const members = source[union];
    if (Array.isArray(members)) result[union] = members.map((child: TSchema) => boundedLocator(child, key));
  }
  if (source.items && !Array.isArray(source.items)) result.items = boundedLocator(source.items as TSchema, key);
  if (key === 'route') result.maxItems = 16;
  return result;
}
export const WikiLocatorSchema = boundedLocator(LocatorSchema) as typeof LocatorSchema;

// A recorded rights basis is provenance, never legal clearance or authority.
export const wikiRightsBases = ['original_contribution', 'unprotected_fact', 'public_domain', 'license',
  'permission', 'statutory_exception', 'service_terms', 'unknown'] as const;
export const WikiNameSchema = Type.Object({ value: text, language,
  kind: choice(['primary', 'alias', 'title']), revealedAt: id }, closed);
export const WikiUnitSchema = Type.Object({ id, ordinal: Type.Integer({ minimum: 0, maximum: 1_000_000 }),
  label: text, occurrence: Type.Union([WikiResourceSchema, Type.Null()]) }, closed);
export const WikiEntitySchema = Type.Object({ id, type: WikiIriSchema,
  names: Type.Array(WikiNameSchema, { minItems: 1, maxItems: WIKI_EXTRACTION_LIMITS.namesPerEntity }),
  match: Type.Optional(WikiResourceSchema) }, closed);
export const WikiObjectSchema = Type.Union([
  Type.Object({ kind: literal('entity'), ref: Type.Union([id, WikiResourceSchema]) }, closed),
  Type.Object({ kind: literal('literal'), value: text, language: Type.Optional(language) }, closed),
]);
export const WikiEvidenceSchema = Type.Object({ locator: WikiLocatorSchema, quote: text }, closed);
export const WikiClaimSchema = Type.Object({ subject: Type.Union([id, WikiResourceSchema]),
  predicate: WikiIriSchema, object: WikiObjectSchema,
  modality: choice(['narrated', 'said', 'rumoured', 'hypothetical']), continuity: WikiResourceSchema,
  revealedAt: id, evidence: Type.Array(WikiEvidenceSchema,
    { minItems: 1, maxItems: WIKI_EXTRACTION_LIMITS.evidencePerClaim }) }, closed);
export const WikiExtractionSchema = Type.Object({ profile: literal(WIKI_EXTRACTION_PROFILE),
  target: WikiResourceSchema, zone: WikiResourceSchema, continuity: WikiResourceSchema,
  source: Type.Object({ representationSha256: sha256,
    mediaType: Type.String({ minLength: 1, maxLength: 200,
      pattern: '^[A-Za-z0-9!#$&^_.+-]+/[A-Za-z0-9!#$&^_.+-]+$' }), language,
    rightsBasis: choice(wikiRightsBases), method: Type.Object({ agent: text, model: text,
      inference: choice(['local', 'provider']) }, closed) }, closed),
  units: Type.Array(WikiUnitSchema, { minItems: 1, maxItems: WIKI_EXTRACTION_LIMITS.units }),
  entities: Type.Array(WikiEntitySchema, { maxItems: WIKI_EXTRACTION_LIMITS.entities }),
  claims: Type.Array(WikiClaimSchema, { maxItems: WIKI_EXTRACTION_LIMITS.claims }),
}, closed);
export type WikiExtraction = Static<typeof WikiExtractionSchema>;
export type WikiEvidence = Static<typeof WikiEvidenceSchema>;
export type WikiClaim = Static<typeof WikiClaimSchema>;
export const WikiCandidatesSchema = Type.Object({ target: WikiResourceSchema, zone: WikiResourceSchema,
  names: Type.Array(Type.Object({ value: text, language, type: Type.Optional(WikiIriSchema) }, closed),
    { minItems: 1, maxItems: WIKI_EXTRACTION_LIMITS.namesPerLookup }) }, closed);
export type WikiCandidates = Static<typeof WikiCandidatesSchema>;
