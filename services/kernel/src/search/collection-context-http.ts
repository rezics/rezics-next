import { t } from 'elysia';
const closed = { additionalProperties: false } as const;
const id = t.String({ format: 'uuid' });
const nullableText = t.Union([t.String(), t.Null()]);
export const CollectionCuratorSchema = t.Union([
  t.Object(
    {
      state: t.Literal('available'),
      id,
      label: t.Union([t.String({ maxLength: 160 }), t.Null()]),
      destination: nullableText,
    },
    closed,
  ),
  t.Object(
    {
      state: t.Literal('unavailable'),
      reason: t.Union((['deidentified', 'withheld', 'native_projection'] as const).map((value) => t.Literal(value))),
    },
    closed,
  ),
]);
export const CollectionPreviewSchema = t.Union([
  t.Object(
    {
      state: t.Literal('available'),
      members: t.Array(
        t.Object(
          {
            id,
            subject: t.Object(
              {
                id,
                type: t.String({ maxLength: 256 }),
                types: t.Array(t.String({ maxLength: 256 }), { maxItems: 32 }),
                label: t.Union([
                  t.Object({ value: t.String({ maxLength: 160 }), language: t.String() }, closed),
                  t.Null(),
                ]),
              },
              closed,
            ),
          },
          closed,
        ),
        { minItems: 1, maxItems: 3 },
      ),
      partial: t.Boolean(),
      truncated: t.Boolean(),
    },
    closed,
  ),
  ...(['empty', 'withheld', 'unavailable'] as const).map((state) => t.Object({ state: t.Literal(state) }, closed)),
]);
export const FollowDiscoverySchema = t.Union([
  t.Object({ state: t.Literal('signed-out') }, closed),
  t.Object(
    {
      state: t.Literal('unavailable'),
      reason: t.Union((['identity', 'scope', 'changed', 'native'] as const).map((reason) => t.Literal(reason))),
    },
    closed,
  ),
  t.Object(
    {
      state: t.Literal('current'),
      accountId: id,
      partition: t.Integer({ minimum: 0, maximum: 4095 }),
      rows: t.Array(
        t.Object(
          {
            targetId: id,
            targetType: t.Union([t.Literal('collection'), t.Literal('space')]),
            source: t.String({ maxLength: 1024 }),
            following: t.Boolean(),
            actions: t.Object({ follow: t.Boolean(), unfollow: t.Boolean() }, closed),
          },
          closed,
        ),
        { maxItems: 100 },
      ),
    },
    closed,
  ),
]);
