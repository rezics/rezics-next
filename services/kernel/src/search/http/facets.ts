import { t } from 'elysia';
const object = { additionalProperties: false } as const;
export const facetResponse = t.Object(
  {
    facets: t.Array(
      t.Object(
        {
          property: t.String(),
          next: t.Union([t.String(), t.Null()]),
          values: t.Array(
            t.Object(
              {
                value: t.String(),
                labels: t.Record(t.String(), t.String()),
              },
              object,
            ),
          ),
        },
        object,
      ),
    ),
    as_of: t.String({ format: 'date-time' }),
  },
  object,
);
