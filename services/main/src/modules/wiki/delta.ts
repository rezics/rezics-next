import Type, { type Static } from 'typebox';
import { Value } from 'typebox/value';
import { canonicalCandidate, EditorialInvalid } from '../editorial-review/contract.ts';
import { WikiExtractionSchema, WikiNativeResourceSchema } from './protocol.ts';
import { checkWikiExtraction } from './validate.ts';

const closed = { additionalProperties: false };
export const WikiRevisionSetSchema = Type.Array(
  Type.Object(
    {
      proposal: Type.String({ format: 'uuid' }),
      revision: Type.Integer({ minimum: 1 }),
      digest: Type.String({ pattern: '^[0-9a-f]{64}$' }),
    },
    closed,
  ),
  { maxItems: 64 },
);
export const WikiDeltaSchema = Type.Object(
  {
    profile: Type.Literal('wiki-delta-v1'),
    base: WikiRevisionSetSchema,
    bundle: WikiExtractionSchema,
    changes: Type.Array(
      Type.Object(
        {
          claim: WikiNativeResourceSchema,
          revision: WikiNativeResourceSchema,
          operation: Type.Union([Type.Literal('retract'), Type.Literal('amend')]),
          reason: Type.String({ minLength: 1, maxLength: 2000 }),
          // Retractions are assertions too: retain and check their source citations.
          evidenceClaim: Type.Integer({ minimum: 0, maximum: 255 }),
        },
        closed,
      ),
      { maxItems: 256 },
    ),
  },
  closed,
);
export type WikiDelta = Static<typeof WikiDeltaSchema>;
export type WikiRevisionSet = Static<typeof WikiRevisionSetSchema>;
export const WIKI_DELTA_COST = { revisions: 64, changes: 256, bytes: 1_048_576 } as const;
export const isWikiDelta = (value: unknown): value is WikiDelta =>
  !!value && typeof value === 'object' && 'profile' in value && value.profile === 'wiki-delta-v1';
export function checkWikiDelta(value: unknown): WikiDelta {
  if (
    new TextEncoder().encode(JSON.stringify(value)).length > WIKI_DELTA_COST.bytes ||
    !Value.Check(WikiDeltaSchema, value)
  )
    throw new EditorialInvalid('Invalid wiki delta');
  checkWikiExtraction(value.bundle);
  if (
    new Set(value.base.map((pin) => pin.proposal)).size !== value.base.length ||
    new Set(value.changes.map((change) => change.claim)).size !== value.changes.length ||
    value.changes.some(
      (change) => !change.reason.trim() || !value.bundle.claims[change.evidenceClaim],
    )
  ) {
    throw new EditorialInvalid('Delta references must be unique and carry a cited reason');
  }
  return value;
}
export function revisionSetDigest(base: WikiRevisionSet): string {
  return canonicalCandidate(base).digest;
}
