import { t } from 'elysia';
import { languageTag } from '../modules/display-language/schema.ts';

const ref = t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' });
const rational = t.Object(
  {
    numerator: t.Integer({ minimum: 0, maximum: 1_000_000_000_000 }),
    denominator: t.Integer({ minimum: 1, maximum: 1_000_000_000_000 }),
  },
  { additionalProperties: false },
);
const scaling = t.Union([t.Literal('linear'), t.Literal('non-linear'), t.Literal('not-scalable')]);
const text = (max: number) =>
  t.Object(
    {
      value: t.String({ minLength: 1, maxLength: max }),
      language: languageTag,
    },
    { additionalProperties: false },
  );
export const ingredientLine = t.Object(
  {
    type: t.Literal('ingredient-line'),
    originalText: text(1000),
    amountLexical: t.Optional(t.String({ minLength: 1, maxLength: 100 })),
    amount: t.Optional(rational),
    amountUpper: t.Optional(rational),
    unit: t.Optional(t.String({ minLength: 1, maxLength: 2048 })),
    unitText: t.Optional(t.String({ minLength: 1, maxLength: 100 })),
    preparation: t.Optional(text(500)),
    optional: t.Boolean(),
    scaling,
    substituteFor: t.Array(ref, { maxItems: 16 }),
    parseStatus: t.Union([t.Literal('parsed'), t.Literal('partial'), t.Literal('unparsed')]),
    residual: t.Optional(t.String({ pattern: '^sha256:[0-9a-f]{64}$' })),
  },
  { additionalProperties: false },
);
export const recipeStep = t.Object(
  {
    type: t.Literal('recipe-step'),
    instructionText: text(4000),
    usesIngredient: t.Array(ref, { maxItems: 64 }),
    media: t.Array(t.String({ format: 'uri' }), { maxItems: 16 }),
    scaling,
  },
  { additionalProperties: false },
);
