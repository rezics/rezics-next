import { t } from 'elysia';
import type { Static } from 'typebox';

const closed = { additionalProperties: false } as const;
const id = t.String({ format: 'uuid' });
const nullable = <S extends import('typebox').TSchema>(schema: S) => t.Union([schema, t.Null()]);
const identity = t.Union([
  t.Object(
    {
      state: t.Literal('available'),
      accountId: id,
      displayName: nullable(t.String({ maxLength: 4096 })),
      handle: nullable(t.String({ maxLength: 64 })),
      label: t.String({ maxLength: 4096 }),
      destination: nullable(t.String({ maxLength: 80 })),
    },
    closed,
  ),
  t.Object(
    { state: t.Literal('concealed'), accountId: id, label: t.Literal('Account'), destination: t.Null() },
    closed,
  ),
]);
const item = t.Object(
  {
    accountId: id,
    reason: t.String({ maxLength: 1024 }),
    actor: nullable(id),
    at: t.String(),
    account: identity,
    moderator: nullable(identity),
    unban: t.Object(
      {
        state: t.Literal('permitted'),
        realmId: id,
        accountId: id,
        observedAt: t.String(),
        membershipRestored: t.Literal(false),
      },
      closed,
    ),
    removal: t.Object({ state: t.Literal('unavailable') }, closed),
  },
  closed,
);
const context = t.Union([
  t.Object(
    {
      state: t.Literal('available'),
      realmTitle: t.String({ maxLength: 1024 }),
      spaceId: id,
      spaceTitle: t.String({ maxLength: 1024 }),
    },
    closed,
  ),
  t.Object({ state: t.Literal('concealed') }, closed),
]);
export const banReviewPageSchema = t.Object(
  {
    items: t.Array(item, { maxItems: 100 }),
    next: nullable(t.String({ maxLength: 4096 })),
    context,
    viewer: t.Object(
      {
        accountId: id,
        clientId: t.String(),
        requestedBy: nullable(t.String()),
        authnEpoch: t.Integer(),
        unban: t.Object(
          {
            state: t.Literal('permitted'),
            operationId: t.Literal('realm.unban'),
            action: t.Literal('realm:ban'),
            resource: t.Object({ route: t.Integer(), id }, closed),
            reauthorizes: t.Literal(true),
          },
          closed,
        ),
      },
      closed,
    ),
    selected: t.Union([
      t.Object({ state: t.Literal('not-requested') }, closed),
      t.Object({ state: t.Literal('current'), ban: item }, closed),
      t.Object({ state: t.Literal('absent'), accountId: id, account: identity }, closed),
    ]),
  },
  closed,
);
export const banReviewPageQuerySchema = t.Object(
  {
    limit: t.Optional(t.Integer({ minimum: 1, maximum: 100 })),
    cursor: t.Optional(t.String({ minLength: 1, maxLength: 4096 })),
    selectedAccountId: t.Optional(id),
  },
  closed,
);
export type BanReviewPage = Static<typeof banReviewPageSchema>;
export type BanReviewPageItem = BanReviewPage['items'][number];
export type BanReviewIdentity = BanReviewPageItem['account'];
export type BanReviewPageQuery = Static<typeof banReviewPageQuerySchema>;
