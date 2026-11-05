import { memoizedValue } from '../../memoized.ts';
import { SubjectSummarySchema } from '../../semantic/http/summaries.ts';
import { t } from 'elysia';

const object = { additionalProperties: false } as const;
const contextLabel = t.Object(
  { value: t.String({ minLength: 1, maxLength: 256 }), language: t.String({ minLength: 1, maxLength: 35 }) },
  object,
);
const contextDate = t.Union([
  t.Object(
    {
      state: t.Literal('value'),
      property: t.String({ minLength: 1, maxLength: 128 }),
      value: t.String({ pattern: '^\\d{4}$' }),
      precision: t.Literal('year'),
    },
    object,
  ),
  t.Object(
    {
      state: t.Literal('value'),
      property: t.String({ minLength: 1, maxLength: 128 }),
      value: t.String({ pattern: '^\\d{4}-(0[1-9]|1[0-2])$' }),
      precision: t.Literal('month'),
    },
    object,
  ),
  t.Object(
    {
      state: t.Literal('value'),
      property: t.String({ minLength: 1, maxLength: 128 }),
      value: t.String({ pattern: '^\\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\\d|3[01])$' }),
      precision: t.Literal('day'),
    },
    object,
  ),
  t.Object(
    {
      state: t.Union([
        t.Literal('unknown'),
        t.Literal('no_value'),
        t.Literal('withheld'),
        t.Literal('unavailable'),
        t.Literal('not_applicable'),
      ]),
      property: t.String({ minLength: 1, maxLength: 128 }),
    },
    object,
  ),
]);
const workContext = t.Union([
  t.Object(
    {
      subjectId: t.String({ format: 'uuid' }),
      status: t.Literal('available'),
      creator: t.Object(
        {
          id: t.String({ format: 'uuid' }),
          label: contextLabel,
          property: t.String({ minLength: 1, maxLength: 128 }),
          role: contextLabel,
        },
        object,
      ),
      relation: t.Optional(
        t.Object(
          {
            kind: t.Union([t.Literal('work'), t.Literal('release')]),
            id: t.String({ format: 'uuid' }),
            label: contextLabel,
            date: t.Optional(contextDate),
          },
          object,
        ),
      ),
      overflow: t.Optional(t.Boolean()),
    },
    object,
  ),
  t.Object(
    {
      subjectId: t.String({ format: 'uuid' }),
      status: t.Union([
        t.Literal('absent'),
        t.Literal('not_applicable'),
        t.Literal('empty'),
        t.Literal('withheld'),
        t.Literal('unavailable'),
      ]),
    },
    object,
  ),
]);
function result() {
  return memoizedValue(result, () =>
    t.Object(
      {
        id: t.String({ format: 'uuid' }),
        type: t.String(),
        labels: t.Record(t.String(), t.String()),
        summary: t.Union([SubjectSummarySchema, t.Null()]),
        workContext: t.Optional(workContext),
      },
      object,
    ),
  );
}
export function suggestResponse() {
  return memoizedValue(suggestResponse, () =>
    t.Object({ subjects: t.Array(result(), { maxItems: 10 }), as_of: t.String({ format: 'date-time' }) }, object),
  );
}
