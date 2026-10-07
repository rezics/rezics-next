import { t } from 'elysia';

const scope = t.String({ maxLength: 300, pattern: '^(https://|urn:)[^\\s<>"{}|\\\\^`]+$' });
const instant = t.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d{1,3})?Z$' });

/** A complete authored qualification; omission of the bundle means unqualified. */
export const statementQualificationSchema = t.Object(
  {
    definition: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
    interpretationContext: scope,
    valuePrecision: t.Union([t.Literal('exact'), t.Literal('approximate'), t.Literal('uncertain')]),
    valueQualifiers: t.Array(t.Union([t.Literal('disputed-attribution'), t.Literal('inferred')]), {
      maxItems: 2,
      uniqueItems: true,
    }),
    validFrom: t.Nullable(instant),
    validUntil: t.Nullable(instant),
    editionScope: t.Nullable(scope),
  },
  { additionalProperties: false },
);
