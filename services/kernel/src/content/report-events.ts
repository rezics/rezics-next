import { Type, type Static } from 'typebox';

const UUID = Type.String({ pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' });

export const REPORT_EVENTS = {
  'com.rezics.content.report.resolved.v1': Type.Object({ reportId: UUID }, { additionalProperties: false }),
  'com.rezics.content.report.created.v1': Type.Object(
    {
      reportId: UUID,
      targetKind: Type.Union([Type.Literal('board'), Type.Literal('thread'), Type.Literal('post')]),
      targetId: UUID,
      revisionId: Type.Optional(UUID),
    },
    { additionalProperties: false },
  ),
  'com.rezics.content.report-target.projected.v1': Type.Object(
    {
      reportId: UUID,
      targetKind: Type.Union([Type.Literal('board'), Type.Literal('thread'), Type.Literal('post')]),
      targetId: UUID,
    },
    { additionalProperties: false },
  ),
} as const;

export type ReportEventType = keyof typeof REPORT_EVENTS;
export type ReportEventData<T extends ReportEventType> = Static<(typeof REPORT_EVENTS)[T]>;
