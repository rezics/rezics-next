import { Type } from 'typebox';

const reference = Type.Object(
  {
    reportId: Type.String({ pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' }),
  },
  { additionalProperties: false },
);

export const REPORT_LOCATOR_EVENTS = {
  'com.rezics.content.report-reporter.projected.v1': reference,
  'com.rezics.content.report-reporter.erased.v1': reference,
  'com.rezics.content.report.evidence-erased.v1': reference,
} as const;
