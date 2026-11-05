import { Type, type Static } from 'typebox';

const UUID = Type.String({ pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' });

export const REPORT_EVENTS = {
  'com.rezics.content.report-locator.installed.v1': Type.Object(
    {
      partition: Type.Integer({ minimum: 0, maximum: 4095 }),
      epoch: Type.Integer({ minimum: 1 }),
      position: Type.String({ pattern: '^[0-9]+$' }),
      expected: Type.String({ pattern: '^[0-9]+$' }),
      applied: Type.String({ pattern: '^[0-9]+$' }),
      complete: Type.Boolean(),
    },
    { additionalProperties: false },
  ),
  'com.rezics.content.report-locator.coverage.v1': Type.Object(
    {
      partition: Type.Integer({ minimum: 0, maximum: 4095 }),
    },
    { additionalProperties: false },
  ),
  'com.rezics.content.catalogue-report.projected.v1': Type.Object({ reportId: UUID }, { additionalProperties: false }),
  'com.rezics.content.report.resolved.v1': Type.Object({ reportId: UUID }, { additionalProperties: false }),
  'com.rezics.content.report.created.v1': Type.Object(
    {
      reportId: UUID,
      targetKind: Type.Union([
        Type.Literal('board'),
        Type.Literal('thread'),
        Type.Literal('post'),
        Type.Literal('subject'),
        Type.Literal('space'),
        Type.Literal('realm'),
      ]),
      targetId: UUID,
      revisionId: Type.Optional(UUID),
    },
    { additionalProperties: false },
  ),
  'com.rezics.content.report-target.projected.v1': Type.Object(
    {
      reportId: UUID,
      targetKind: Type.Union([
        Type.Literal('board'),
        Type.Literal('thread'),
        Type.Literal('post'),
        Type.Literal('subject'),
        Type.Literal('space'),
        Type.Literal('realm'),
      ]),
      targetId: UUID,
    },
    { additionalProperties: false },
  ),
} as const;

export type ReportEventType = keyof typeof REPORT_EVENTS;
export type ReportEventData<T extends ReportEventType> = Static<(typeof REPORT_EVENTS)[T]>;
