import Type, { type TSchema } from 'typebox';
import { WikiJournalPinSchema } from './delta.ts';
import { WikiClaimSchema, WikiEvidenceSchema, WikiNameSchema, WikiUnitSchema } from './protocol.ts';
import { mergedIdentity } from '../identity-merge/resolution.ts';

const closed = { additionalProperties: false };
const ref = Type.String({ minLength: 1, maxLength: 2048 });
/** Rights withholding nulls every passage fallback, including locator.quote. */
function disclosed(schema: TSchema, key = ''): TSchema {
  if (['quote', 'exact', 'prefix', 'suffix'].includes(key)) {
    const nullable = Type.Union([schema, Type.Null()]);
    return Type.IsOptional(schema) ? Type.Optional(nullable) : nullable;
  }
  const source = schema as TSchema & Record<string, unknown>;
  const result = { ...schema } as TSchema & Record<string, unknown>;
  if (source.properties)
    result.properties = Object.fromEntries(
      Object.entries(source.properties as Record<string, TSchema>).map(([name, value]) => [
        name,
        disclosed(value, name),
      ]),
    );
  for (const union of ['anyOf', 'oneOf', 'allOf'])
    if (Array.isArray(source[union]))
      result[union] = source[union].map((value: TSchema) => disclosed(value));
  if (source.items && !Array.isArray(source.items))
    result.items = disclosed(source.items as TSchema);
  return result;
}
// Rebuild closed objects when extending: an intersection with an old closed
// object would reject the new disclosure marker or normalized unit identity.
const disclosedEvidence = Type.Object(
  {
    locator: disclosed(WikiEvidenceSchema.properties.locator),
    quote: Type.Union([WikiEvidenceSchema.properties.quote, Type.Null()]),
    quoteWithheld: Type.Boolean(),
  },
  closed,
);
export const WikiHistoryResponseSchema = Type.Object(
  {
    profile: Type.Literal('wiki-history-v1'),
    work: ref,
    revisions: WikiJournalPinSchema,
    claims: Type.Array(
      Type.Object(
        {
          claim: ref,
          revision: ref,
          proposal: Type.String({ format: 'uuid' }),
          index: Type.Integer({ minimum: 0 }),
          endingReceipt: Type.Optional(Type.String({ format: 'uuid' })),
          endingKey: Type.Optional(Type.String()),
          value: Type.Object(
            {
              ...WikiClaimSchema.properties,
              revealedAt: ref,
              evidence: Type.Array(disclosedEvidence),
            },
            closed,
          ),
          evidence: Type.Array(ref),
        },
        closed,
      ),
      { maxItems: 64 },
    ),
    entities: Type.Array(
      Type.Object(
        {
          entity: ref,
          revision: ref,
          type: ref,
          names: Type.Array(Type.Object({ ...WikiNameSchema.properties, revealedAt: ref }, closed)),
        },
        closed,
      ),
      { maxItems: 64 },
    ),
    units: Type.Array(Type.Object({ ...WikiUnitSchema.properties, id: ref }, closed), {
      maxItems: 64,
    }),
    sourcePosition: Type.Object(
      {
        dataEpoch: Type.String({ format: 'uuid' }),
        sequence: Type.String({ pattern: '^[0-9]+$' }),
      },
      closed,
    ),
    scope: Type.Object(
      {
        entity: Type.Optional(ref),
        section: Type.Optional(
          Type.Union([
            Type.Literal('characters'),
            Type.Literal('places'),
            Type.Literal('events'),
            Type.Literal('chapters'),
          ]),
        ),
      },
      closed,
    ),
    revisionSetDigest: Type.String({ pattern: '^[0-9a-f]{64}$' }),
    resolutions: Type.Record(ref, mergedIdentity),
    nextCursor: Type.Union([Type.String({ maxLength: 2048 }), Type.Null()]),
  },
  closed,
);
