import { t } from 'elysia';
import { ReportInputSchema } from './schemas.ts';

const closed = { additionalProperties: false } as const;
const nullable = <T extends ReturnType<typeof t.String>>(schema: T) => t.Union([schema, t.Null()]);
const action = t.Object({ method: t.Literal('GET'), href: t.String() }, closed);
export const ReporterHistoryQuerySchema = t.Object(
  {
    cursor: t.Optional(t.String()),
    reportId: t.Optional(t.String()),
  },
  closed,
);
export const ReporterHistoryPageSchema = t.Object(
  {
    state: t.Union([t.Literal('ready'), t.Literal('preparing')]),
    entries: t.Array(
      t.Object(
        {
          id: t.String(),
          target: ReportInputSchema.properties.target,
          revisionId: nullable(t.String()),
          reason: t.String(),
          evidence: nullable(t.String()),
          createdAt: t.String(),
          outcome: t.Union([t.Literal('actioned'), t.Literal('dismissed'), t.Null()]),
          resolvedAt: nullable(t.String()),
          targetSummary: t.Union([
            t.Object({ state: t.Literal('available'), label: nullable(t.String()), href: t.String() }, closed),
            t.Object({ state: t.Literal('unavailable') }, closed),
          ]),
          viewer: t.Object({ ownsReport: t.Literal(true) }, closed),
          actions: t.Object({ open: action, follow: action, target: t.Union([action, t.Null()]) }, closed),
        },
        closed,
      ),
      { maxItems: 21 },
    ),
    selectedReportId: nullable(t.String()),
    nextCursor: nullable(t.String()),
    retry: t.Object({ cursor: nullable(t.String()) }, closed),
    viewer: t.Object({ kind: t.Literal('reporter') }, closed),
  },
  closed,
);
