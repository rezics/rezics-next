import { t } from 'elysia';
import { displayLanguageBasis } from '../display-language/schema.ts';
import { AVATAR_POLICY } from './store.ts';
import { FALLBACK_POLICY, MAX_SUMMARY_BATCH } from './summary.ts';
import { targetBase, targetRef } from '../target/contract.ts';
import { mergedIdentity } from '../identity-merge/resolution.ts';
import { readAssessment } from '../suitability/contract.ts';
import { imageNsfw } from './presentation-contract.ts';
import { canonicalAddress } from '../address/schema.ts';

// Written as literals, not mapped from an array, so the contract's static type is the union and not `never`.
const resourceType = t.Union([t.Literal('work'), t.Literal('main-version'), t.Literal('space'), t.Literal('realm'),
  t.Literal('agent'), t.Literal('zone'),
  t.Literal('concept'), t.Literal('character'), t.Literal('context'), t.Literal('role'),
  t.Literal('relation-definition'), t.Literal('release'), t.Literal('occurrence'), t.Literal('realization'),
  t.Literal('resource'), t.Literal('collection'), t.Literal('projection')]);
const name = t.Object({ value: t.String(), language: t.String(),
  direction: t.Union([t.Literal('ltr'), t.Literal('rtl')]),
  basis: displayLanguageBasis,
  context: t.Optional(t.String()), preferenceRevision: t.Optional(t.String()) },
{ additionalProperties: false });
const avatar = t.Union([
  t.Object({ kind: t.Literal('fallback'), policy: t.Literal(FALLBACK_POLICY), key: t.String(),
    resourceType }, { additionalProperties: false }),
  t.Object({ kind: t.Literal('image'), selection: t.String(), url: t.String(),
    representation:t.Optional(t.String()),use:t.Optional(t.String()),nsfw:t.Optional(imageNsfw),
    ageRating:t.Optional(readAssessment),conceal:t.Optional(t.Boolean()),
    mediaType: t.String(), width: t.Integer({ minimum: 1 }), height: t.Integer({ minimum: 1 }),
    crop: t.Nullable(t.String()),
    basis: t.Object({ policy: t.Literal(AVATAR_POLICY), context: t.String() },
      { additionalProperties: false }) }, { additionalProperties: false }),
]);

const availableSummary = { reference: t.String(), status: t.Literal('available'), type: resourceType,
  base: t.Nullable(targetBase), work: t.Nullable(targetRef),
  address: canonicalAddress,
  disclosure: t.Union([t.Literal('public'), t.Literal('restricted')]), name, avatar };
/** One part of a projection: an available summary that has no parts or resolution of its own. */
const summaryPart = t.Object(availableSummary, { additionalProperties: false });

/** Unavailable entries carry only the requested reference; no name or media basis can escape. */
export const resourceSummary = t.Union([
  t.Object({ reference: t.String(), status: t.Literal('unavailable') },
    { additionalProperties: false }),
  t.Object({ ...availableSummary, resolution: t.Optional(mergedIdentity),
    /** A projection's subject and frames, each a summary; its own name is the subject's. */
    parts: t.Optional(t.Object({ subject: summaryPart, frames: t.Array(summaryPart, { minItems: 1, maxItems: 8 }) },
      { additionalProperties: false })) },
  { additionalProperties: false }),
]);

/** One bounded owner batch, with partial results in input order and explicit cost. */
export const resourceSummaryBatch = t.Object({ profile: t.Literal('resource-summary-batch-v1'),
  complete: t.Literal(true), summaries: t.Array(resourceSummary,
    { minItems: 1, maxItems: MAX_SUMMARY_BATCH }),
  generation: t.Object({ graph: t.String(), media: t.Nullable(t.String()),addresses: t.Optional(t.String()) },
    { additionalProperties: false }),
  cost: t.Object({ graphQueries: t.Integer({ minimum: 1 }), mediaQueries: t.Integer({ minimum: 0, maximum: 1 }),
    accessChecks: t.Integer({ minimum: 0 }), accessQueries: t.Integer({ minimum: 0 }) },
  { additionalProperties: false }),
}, { additionalProperties: false });
