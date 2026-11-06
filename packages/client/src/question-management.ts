import { Type as t, type Static, type TSchema } from 'typebox';
import { Value } from 'typebox/value';
import type { QuestionLabelHistory } from './index';

// Consumer schemas for the native closed response envelopes. No server implementation is loaded by Client.
const closed = { additionalProperties: false } as const;
const id = t.String({ format: 'uuid' });
const revision = t.Integer({ minimum: 1, maximum: 2_147_483_647 });
const href = t.String({ minLength: 1, maxLength: 128 });
const caption = t.String({ minLength: 1, maxLength: 200 });
const question = t.Object(
  {
    id,
    revision,
    realmId: id,
    meaning: t.String({ minLength: 1, maxLength: 2000 }),
    canonicalLabel: caption,
    label: caption,
    labelRevision: revision,
    grain: t.Union([t.Literal('work'), t.Literal('release'), t.Literal('episode'), t.Literal('character')]),
    lifecycle: t.Object({ state: t.Union([t.Literal('active'), t.Literal('retired')]), revision }, closed),
    scale: t.Object({ min: t.Integer(), max: t.Integer(), displayStep: t.Integer({ minimum: 1 }) }, closed),
  },
  closed,
);
const nullable = <T extends TSchema>(schema: T) => t.Union([schema, t.Null()]);
const management = t.Object(
  {
    viewer: t.Object({ accountId: id }, closed),
    realmId: id,
    directory: t.Object(
      {
        ratingQuestions: t.Array(question, { maxItems: 20 }),
        next: nullable(t.String({ minLength: 1, maxLength: 4096 })),
      },
      closed,
    ),
    actions: t.Object({ create: nullable(t.Object({ method: t.Literal('POST'), href }, closed)) }, closed),
    selected: nullable(
      t.Object(
        {
          question,
          readback: href,
          history: href,
          actions: t.Object(
            {
              caption: nullable(t.Object({ method: t.Literal('PUT'), href, expectedLabelRevision: revision }, closed)),
              lifecycle: nullable(
                t.Object({ method: t.Literal('POST'), href, expectedLifecycleRevision: revision }, closed),
              ),
            },
            closed,
          ),
        },
        closed,
      ),
    ),
  },
  closed,
);
const author = nullable(
  t.Union([
    t.Object(
      { id, kind: t.Union([t.Literal('actor'), t.Literal('organization')]), state: t.Literal('deleted') },
      closed,
    ),
    t.Object(
      {
        id,
        kind: t.Union([t.Literal('actor'), t.Literal('organization')]),
        state: t.Literal('active'),
        handle: nullable(t.String()),
        displayName: nullable(t.String()),
        automated: t.Boolean(),
        operatorId: nullable(id),
      },
      closed,
    ),
  ]),
);
const history = t.Object(
  {
    labels: t.Array(
      t.Object(
        {
          questionId: id,
          labelRevision: revision,
          label: caption,
          at: nullable(t.String({ format: 'date-time' })),
          author,
        },
        closed,
      ),
      { maxItems: 20 },
    ),
    next: nullable(t.String()),
  },
  closed,
);

export type QuestionManagementPage = Static<typeof management>;

/** Third-party response admission retains every native field and rejects unexpected envelope fields. */
export function decodeQuestionManagementPage(value: unknown): QuestionManagementPage | null {
  return Value.Check(management, value) ? value : null;
}

export function decodeQuestionLabelHistory(value: unknown): QuestionLabelHistory | null {
  return Value.Check(history, value) ? (value as QuestionLabelHistory) : null;
}
