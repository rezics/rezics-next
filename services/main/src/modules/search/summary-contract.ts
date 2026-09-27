import { t } from 'elysia';

const resourceType = t.Union(['work', 'main-version', 'space', 'realm', 'concept', 'character',
  'context', 'role', 'relation-definition'].map(value => t.Literal(value)));
const name = t.Object({ value: t.String(), language: t.String(),
  direction: t.Union([t.Literal('ltr'), t.Literal('rtl')]),
  basis: t.Union([t.Literal('requested'), t.Literal('fallback')]),
  context: t.Optional(t.String()), preferenceRevision: t.Optional(t.String()) });
const avatar = t.Union([
  t.Object({ kind: t.Literal('fallback'), policy: t.String(), key: t.String(),
    resourceType }),
  t.Object({ kind: t.Literal('image'), selection: t.String(), url: t.String(),
    mediaType: t.String(), width: t.Integer(), height: t.Integer(), crop: t.Nullable(t.String()),
    basis: t.Object({ policy: t.String(), context: t.String() }) }),
]);

/** The batch remains separate from phrase search's 1.5 second graph budget. */
export const resourceSummaryBatch = t.Object({ profile: t.Literal('resource-summary-batch-v1'),
  complete: t.Literal(true), summaries: t.Array(t.Union([
    t.Object({ reference: t.String(), status: t.Literal('unavailable') }),
    t.Object({ reference: t.String(), status: t.Literal('available'),
      type: resourceType,
      disclosure: t.Union([t.Literal('public'), t.Literal('restricted')]), name, avatar }),
  ]), { maxItems: 64 }),
  generation: t.Object({ graph: t.String(), media: t.Nullable(t.String()) }),
  cost: t.Object({ graphQueries: t.Integer(), mediaQueries: t.Integer(),
    accessChecks: t.Integer(), accessQueries: t.Integer() }),
});
