import { Type } from 'typebox';

const nullableText = Type.Union([Type.String(), Type.Null()]);
const key = Type.Union([
  Type.Tuple([Type.String()]),
  Type.Tuple([nullableText, Type.String()]),
  Type.Tuple([Type.Number(), nullableText, Type.String()]),
]);
const candidate = Type.Object({ id: Type.String(), key, source: Type.Number() });
const pending = Type.Object({
  subject: Type.String(),
  source: Type.Number(),
  collection: Type.Optional(
    Type.Object({
      subjectId: Type.String(),
      basisDigest: Type.String(),
      aliasAfter: nullableText,
      sourceAfter: Type.Union([
        Type.TemplateLiteral([
          Type.Literal('1:'),
          Type.Union([0, 1, 2, 3, 4, 5].map((value) => Type.Literal(value))),
          Type.Literal(':'),
          Type.String(),
          Type.Literal(':'),
          Type.String(),
        ]),
        Type.Null(),
      ]),
    }),
  ),
  scope: Type.Optional(
    Type.Object({
      subject: Type.String(),
      basis: Type.String(),
      leafOrdinal: Type.Number(),
      phase: Type.Union([Type.Literal('compact'), Type.Literal('selection'), Type.Literal('witness')]),
      valueOrdinal: Type.Number(),
      after: nullableText,
    }),
  ),
  conjunct: Type.Optional(Type.Union([Type.Literal('source'), Type.Literal('zone')])),
  zoneSource: Type.Optional(Type.Number()),
});
const position = Type.Object({
  basis: Type.String(),
  after: Type.Union([key, Type.Null()]),
  rows: Type.Array(candidate),
  pending: Type.Optional(pending),
  discovery: Type.Optional(
    Type.Object({
      next: Type.Number(),
      rows: Type.Array(candidate),
      covered: Type.Union([key, Type.Null()]),
      exhausted: Type.Boolean(),
    }),
  ),
  exhausted: Type.Boolean(),
});
export const ZonePagePositionSchema = Type.Object({ reads: Type.Record(Type.String(), position) });
