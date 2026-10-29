import { Type, type Static } from 'typebox';
import { valueSchema } from '@rezics/definitions';
import { BatchStatementSchema, SourceSchema } from '@rezics/definitions/bulk';
import type { Item } from './item.ts';

// Proposed source input only. Validation grants neither trust nor native admission.
const closed = { additionalProperties: false } as const;
const text = Type.String({ minLength: 1, maxLength: 1500 });
const nativeId = Type.Unsafe<Item['id']>(valueSchema('wikibase-item'));
// checkSubjectStructure/valueLimits in definitions/src/validate.ts also apply.
const exact = valueSchema('quantity', { exact: true, integer: true, units: ['1'] });
const count = Type.Unsafe<{ amount: string; unit: '1' }>({
  ...exact,
  // Counts narrow the generic signed integer primitive to nonnegative amounts.
  allOf: [{ properties: { amount: { pattern: '^(?:\\+(?:0|[1-9][0-9]*)|-0)$', maxLength: 127 } } }],
});
const statement = Type.Object(
  {
    ...BatchStatementSchema.properties,
    qualifiers: Type.Optional(Type.Array(BatchStatementSchema.properties.qualifiers.items, { maxItems: 16 })),
    references: Type.Array(
      Type.Object(
        {
          parts: Type.Array(BatchStatementSchema.properties.references.items.properties.parts.items, {
            minItems: 1,
            maxItems: 16,
          }),
        },
        closed,
      ),
      { minItems: 1, maxItems: 16 },
    ),
    property: Type.Object(
      { id: Type.Union([Type.Literal('schema:wordCount'), Type.Literal('rezics:characterCount')]) },
      closed,
    ),
    value: Type.Union([
      Type.Object({ type: Type.Literal('value'), content: count }, closed),
      Type.Object({ type: Type.Literal('somevalue') }, closed),
      Type.Object({ type: Type.Literal('novalue') }, closed),
    ]),
  },
  closed,
);
const common = {
  holder: nativeId,
  producer: nativeId,
  // Exact native schema:inLanguage scalar (catalogue/core.yaml), without normalization.
  language: Type.Unsafe<string>(
    valueSchema('string', { pattern: '^[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-(?:[A-Z]{2}|[0-9]{3}))?$' }),
  ),
  version: Type.Union([
    Type.Object({ kind: Type.Literal('declared'), value: text }, closed),
    Type.Object({ kind: Type.Literal('unversioned') }, closed),
  ]),
  coverage: Type.Object(
    {
      kind: Type.Union([
        Type.Literal('whole-holder'),
        Type.Literal('partial'),
        Type.Literal('unknown'),
        Type.Literal('unsupported-multilingual'),
      ]),
      included: Type.Array(text, { minItems: 1 }),
      excluded: Type.Array(text),
    },
    closed,
  ),
  // Actual native references stay attached to this one statement; no parallel citation list.
  statement,
  source: Type.Optional(Type.Object(SourceSchema.properties, closed)),
};

/** Closed proposal; no runtime producer signature or HTTP transport is selected. */
export const CountProducerInputSchema = Type.Union([
  Type.Object(
    {
      ...common,
      kind: Type.Literal('supplied-text'),
      // Necessary character ceiling for the 32 KiB authored-field fixture path.
      // NOT a UTF-8/snapshot byte check or an admitted source-input transport.
      text: Type.String({ maxLength: 32_768 }),
      digest: Type.String({ pattern: '^sha256:[0-9a-f]{64}$' }),
      measuredAt: Type.String({ pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$' }),
      method: Type.Object({ concept: nativeId, version: text, definition: text }, closed),
    },
    closed,
  ),
  Type.Object(
    {
      ...common,
      kind: Type.Literal('reported-total'),
      declaration: Type.Object(
        {
          kind: Type.Union([Type.Literal('work-total'), Type.Literal('serial-total'), Type.Literal('publisher-total')]),
          convention: text,
        },
        closed,
      ),
    },
    closed,
  ),
]);
export type CountProducerInput = Static<typeof CountProducerInputSchema>;
