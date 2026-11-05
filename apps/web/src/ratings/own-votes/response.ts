import Type from 'typebox';
import { Value } from 'typebox/value';
import type { OwnVoteActions, OwnVotesPage } from './types';

const closed = { additionalProperties: false } as const;
const uuid = Type.String({ format: 'uuid' });
const revision = Type.Integer({ minimum: 1, maximum: 2_147_483_647 });

const cover = Type.Union([
  Type.Object(
    {
      media: uuid,
      width: Type.Integer({ minimum: 1 }),
      height: Type.Integer({ minimum: 1 }),
      placeholder: Type.Object({ thumbhash: Type.String(), color: Type.String() }, closed),
      variants: Type.Array(
        Type.Object(
          { format: Type.Union([Type.Literal('avif'), Type.Literal('webp')]), width: Type.Integer({ minimum: 1 }) },
          closed,
        ),
      ),
      focalPoint: Type.Union([Type.Object({ x: Type.Number(), y: Type.Number() }, closed), Type.Null()]),
      credit: Type.Object(
        {
          rightsHolder: Type.String(),
          via: Type.Object({ name: Type.String(), url: Type.String() }, closed),
          license: Type.String(),
          obligations: Type.Array(Type.String()),
        },
        closed,
      ),
    },
    closed,
  ),
  Type.Null(),
]);
const subject = Type.Object(
  {
    id: uuid,
    type: Type.String(),
    types: Type.Array(Type.String()),
    label: Type.Union([Type.Object({ value: Type.String(), language: Type.String() }, closed), Type.Null()]),
    creativeWork: Type.Boolean(),
    cover,
  },
  closed,
);
const question = Type.Object(
  {
    id: uuid,
    revision,
    realmId: Type.Optional(uuid),
    canonicalLabel: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    labelRevision: Type.Optional(revision),
    meaning: Type.Optional(Type.String({ minLength: 1, maxLength: 2000 })),
    label: Type.String({ minLength: 1, maxLength: 200 }),
    grain: Type.Union([
      Type.Literal('work'),
      Type.Literal('release'),
      Type.Literal('episode'),
      Type.Literal('character'),
    ]),
    lifecycle: Type.Optional(
      Type.Object({ state: Type.Union([Type.Literal('active'), Type.Literal('retired')]), revision }, closed),
    ),
    scale: Type.Object(
      { min: Type.Integer(), max: Type.Integer(), displayStep: Type.Integer({ minimum: 1 }) },
      closed,
    ),
  },
  closed,
);
const actions = Type.Union([
  Type.Object(
    { state: Type.Literal('editable'), put: Type.String(), clear: Type.String(), readback: Type.String() },
    closed,
  ),
  Type.Object(
    {
      state: Type.Literal('retired'),
      reason: Type.Literal('question_retired'),
      clear: Type.String(),
      readback: Type.String(),
    },
    closed,
  ),
  Type.Object(
    {
      state: Type.Literal('unavailable'),
      reason: Type.Union([
        Type.Literal('merged_source'),
        Type.Literal('identity_pending'),
        Type.Literal('read_only'),
      ]),
    },
    closed,
  ),
]);
const vote = Type.Object(
  {
    units: Type.Integer(),
    revision,
    at: Type.String({ format: 'date-time' }),
  },
  closed,
);
const entry = Type.Object(
  {
    targetId: uuid,
    questionId: uuid,
    subject,
    subjectHref: Type.String(),
    question,
    own: vote,
    actions,
  },
  closed,
);

// The native response envelope is additive; each consumed row and its action advice stay closed.
const page = Type.Object(
  {
    viewer: Type.Object({ accountId: uuid }, closed),
    votes: Type.Array(entry, { maxItems: 20 }),
    next: Type.Union([Type.String(), Type.Null()]),
  },
  { additionalProperties: true },
);

export function decodeOwnVotesPage(value: unknown): OwnVotesPage | null {
  if (!Value.Check(page, value)) return null;
  const accepted = value as OwnVotesPage;
  return { viewer: accepted.viewer, votes: accepted.votes, next: accepted.next };
}

export function isOwnVoteActions(value: unknown): value is OwnVoteActions {
  return Value.Check(actions, value);
}
