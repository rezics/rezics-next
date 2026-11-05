import { t } from 'elysia';

const closed = { additionalProperties: false } as const;
const id = t.String({ format: 'uuid' });
const revision = t.Integer({ minimum: 1, maximum: 2_147_483_647 });
const grain = t.Union([t.Literal('work'), t.Literal('release'), t.Literal('episode'), t.Literal('character')]);

export const RatingVoteResponseSchema = t.Object(
  {
    units: t.Integer(),
    revision,
    at: t.String({ format: 'date-time' }),
  },
  closed,
);

export const RatingQuestionLifecycleSchema = t.Object(
  { state: t.Union([t.Literal('active'), t.Literal('retired')]), revision },
  closed,
);

export const RatingQuestionResponseSchema = t.Object(
  {
    id,
    revision,
    realmId: t.Optional(id),
    canonicalLabel: t.Optional(t.String({ minLength: 1, maxLength: 200 })),
    labelRevision: t.Optional(revision),
    meaning: t.Optional(t.String({ minLength: 1, maxLength: 2000 })),
    label: t.String({ minLength: 1, maxLength: 200 }),
    grain,
    lifecycle: t.Optional(RatingQuestionLifecycleSchema),
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
