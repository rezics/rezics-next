import { t } from 'elysia';
import { strictContentSchema } from '../content/schemas.ts';

const closed = { additionalProperties: false } as const;
const id = t.String({ format: 'uuid' });
const revision = t.Integer({ minimum: 1, maximum: 2_147_483_647 });
const grain = t.Union([t.Literal('work'), t.Literal('release'), t.Literal('episode'), t.Literal('character')]);

export const RatingVoteInputSchema = strictContentSchema(t.Object({ units: t.Integer() }, closed));

export const RatingVoteResponseSchema = t.Object(
  {
    units: t.Integer(),
    revision,
    at: t.String({ format: 'date-time' }),
  },
  closed,
);

export const RatingQuestionResponseSchema = t.Object(
  {
    id,
    revision,
    label: t.String({ minLength: 1, maxLength: 200 }),
    grain,
    scale: t.Object(
      {
        min: t.Integer(),
        max: t.Integer(),
        displayStep: t.Integer({ minimum: 1 }),
      },
      closed,
    ),
  },
  closed,
);

const sourceScale = t.Object(
  {
    min: t.Integer({ minimum: 0, maximum: 4096 }),
    max: t.Integer({ minimum: 1, maximum: 4096 }),
  },
  closed,
);

export const SourceStatisticInputSchema = strictContentSchema(
  t.Object(
    {
      sourceRecordId: t.String({ minLength: 1, maxLength: 1024 }),
      scale: sourceScale,
      mean: t.Number(),
      count: t.Integer({ minimum: 1, maximum: 2_147_483_647 }),
      asOf: t.String({ format: 'date' }),
      licence: t.String({ minLength: 1, maxLength: 1024 }),
      attribution: t.String({ minLength: 1, maxLength: 2000 }),
    },
    closed,
  ),
);

export const SourceStatisticResponseSchema = t.Object(
  {
    source: t.Literal('vndb'),
    sourceRecordId: t.String({ minLength: 1, maxLength: 1024 }),
    scale: sourceScale,
    mean: t.Number(),
    count: t.Integer({ minimum: 1, maximum: 2_147_483_647 }),
    asOf: t.String({ format: 'date' }),
    licence: t.String({ minLength: 1, maxLength: 1024 }),
    attribution: t.String({ minLength: 1, maxLength: 2000 }),
  },
  closed,
);

export const SourceStatisticListResponseSchema = t.Array(SourceStatisticResponseSchema);
