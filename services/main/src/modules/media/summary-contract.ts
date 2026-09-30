import { t } from 'elysia';
import { displayLanguageBasis } from '../display-language/schema.ts';
import { AVATAR_POLICY } from './store.ts';
import { FALLBACK_POLICY, MAX_SUMMARY_BATCH } from './summary.ts';
import { targetBase, targetRef } from '../target/contract.ts';

const resourceType = t.Union(['work', 'main-version', 'space', 'realm', 'concept', 'character',
  'context', 'role', 'relation-definition', 'release', 'occurrence', 'realization', 'resource']
  .map(value => t.Literal(value)));
const name = t.Object({ value: t.String(), language: t.String(),
  direction: t.Union([t.Literal('ltr'), t.Literal('rtl')]),
  basis: displayLanguageBasis,
  context: t.Optional(t.String()), preferenceRevision: t.Optional(t.String()) },
{ additionalProperties: false });
const avatar = t.Union([
  t.Object({ kind: t.Literal('fallback'), policy: t.Literal(FALLBACK_POLICY), key: t.String(),
    resourceType }, { additionalProperties: false }),
  t.Object({ kind: t.Literal('image'), selection: t.String(), url: t.String(),
    mediaType: t.String(), width: t.Integer({ minimum: 1 }), height: t.Integer({ minimum: 1 }),
    crop: t.Nullable(t.String()),
    basis: t.Object({ policy: t.Literal(AVATAR_POLICY), context: t.String() },
      { additionalProperties: false }) }, { additionalProperties: false }),
]);

/** Unavailable entries carry only the requested reference; no name or media basis can escape. */
export const resourceSummary = t.Union([
  t.Object({ reference: t.String(), status: t.Literal('unavailable') },
    { additionalProperties: false }),
  t.Object({ reference: t.String(), status: t.Literal('available'), type: resourceType,
    base: t.Nullable(targetBase), work: t.Nullable(targetRef),
    disclosure: t.Union([t.Literal('public'), t.Literal('restricted')]), name, avatar },
  { additionalProperties: false }),
]);

/** One bounded owner batch, with partial results in input order and explicit cost. */
export const resourceSummaryBatch = t.Object({ profile: t.Literal('resource-summary-batch-v1'),
  complete: t.Literal(true), summaries: t.Array(resourceSummary,
    { minItems: 1, maxItems: MAX_SUMMARY_BATCH }),
  generation: t.Object({ graph: t.String(), media: t.Nullable(t.String()) },
    { additionalProperties: false }),
  cost: t.Object({ graphQueries: t.Integer({ minimum: 1 }), mediaQueries: t.Integer({ minimum: 0, maximum: 1 }),
    accessChecks: t.Integer({ minimum: 0 }), accessQueries: t.Integer({ minimum: 0 }) },
  { additionalProperties: false }),
}, { additionalProperties: false });
