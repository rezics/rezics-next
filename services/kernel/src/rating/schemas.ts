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
