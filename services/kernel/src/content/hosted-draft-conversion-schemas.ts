import { t } from 'elysia';
import { HostedIdSchema } from './hosted-chapters-schemas.ts';

const closed = { additionalProperties: false } as const;

/** A retained native cursor is an optimistic replay operand, never proof of source coverage. */
export const HostedDraftConversionFrontierSchema = t.Union([
  t.Object(
    { segment: t.Literal('base'), afterOrdinal: t.Integer({ minimum: -1, maximum: Number.MAX_SAFE_INTEGER }) },
    closed,
  ),
  t.Object({ segment: t.Literal('prefix'), afterOffset: t.String({ pattern: '^(?:-1|0|[1-9][0-9]*)$' }) }, closed),
  t.Object({ segment: t.Literal('complete') }, closed),
]);

const expectedRevision = { expectedRevisionId: HostedIdSchema };
const input = { ...expectedRevision, inputId: HostedIdSchema };

/** One request names a bounded step; source pages and readiness remain native-owned. */
export const HostedDraftConversionSchema = t.Union([
  t.Object({ step: t.Literal('capture'), ...expectedRevision }, closed),
  t.Object({ step: t.Literal('begin'), ...input }, closed),
  t.Object(
    {
      step: t.Literal('page'),
      ...input,
      cursor: HostedDraftConversionFrontierSchema,
    },
    closed,
  ),
  t.Object({ step: t.Literal('seal'), ...input }, closed),
  t.Object({ step: t.Literal('materialize'), ...input }, closed),
  t.Object({ step: t.Literal('materializePage'), ...input }, closed),
  t.Object({ step: t.Literal('commit'), ...input }, closed),
]);

const frontier = HostedDraftConversionFrontierSchema;
const coverage = t.Object(
  {
    visited: t.String({ pattern: '^(?:0|[1-9][0-9]*)$' }),
    expected: t.String({ pattern: '^(?:0|[1-9][0-9]*)$' }),
    complete: t.Boolean(),
  },
  closed,
);

/** Private progress is limited to stage and counts; it contains no source payload or target metadata. */
export const HostedDraftConversionProgressSchema = t.Object(
  {
    catalogueId: HostedIdSchema,
    inputId: HostedIdSchema,
    phase: t.Union([
      t.Literal('captured'),
      t.Literal('building'),
      t.Literal('sealed'),
      t.Literal('materializing'),
      t.Literal('ready-to-activate'),
      t.Literal('complete'),
    ]),
    nextStep: t.Union([
      t.Literal('begin'),
      t.Literal('page'),
      t.Literal('seal'),
      t.Literal('materialize'),
      t.Literal('materializePage'),
      t.Literal('commit'),
      t.Literal('complete'),
    ]),
    frontier: t.Optional(frontier),
    coverage: t.Optional(coverage),
    revisionId: t.Optional(HostedIdSchema),
  },
  closed,
);
