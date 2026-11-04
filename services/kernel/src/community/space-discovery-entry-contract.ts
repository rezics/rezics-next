import { t } from 'elysia';
import type { Static } from 'typebox';
import type { FollowingSpaceActions, FollowingSpaceDestination } from '../library/following-space-contract.ts';

const closed = { additionalProperties: false } as const;
const id = t.String({ format: 'uuid' });
export const SpaceEntryAvatarSchema = t.Union([
  t.Object(
    {
      state: t.Literal('available'),
      mediaId: id,
      realmId: id,
      format: t.Union([t.Literal('avif'), t.Literal('webp')]),
      width: t.Integer({ minimum: 1, maximum: 2560 }),
    },
    closed,
  ),
  t.Object({ state: t.Union([t.Literal('none'), t.Literal('withheld'), t.Literal('unavailable')]) }, closed),
]);
export const SpaceEntryPresentationSchema = t.Object(
  {
    identity: t.Object(
      {
        kind: t.Union([t.Literal('space'), t.Literal('realm')]),
        id,
        name: t.String({ minLength: 1, maxLength: 1024 }),
      },
      closed,
    ),
    avatar: SpaceEntryAvatarSchema,
  },
  closed,
);
const advice = t.Union([t.Literal('allowed'), t.Literal('disabled'), t.Literal('unavailable'), t.Literal('sign-in')]);
export const SpaceEntryFollowSchema = t.Union([
  t.Object({ state: t.Literal('current'), following: t.Boolean(), action: advice }, closed),
  t.Object({ state: t.Union([t.Literal('sign-in'), t.Literal('unavailable')]) }, closed),
]);
const destination = t.Union([
  t.Object({ kind: t.Literal('space'), spaceId: id, address: t.String({ minLength: 1, maxLength: 256 }) }, closed),
  t.Object({ kind: t.Literal('realm'), realmId: id }, closed),
  t.Object({ kind: t.Literal('unavailable') }, closed),
]);
export const SpaceEntryRowSchema = t.Object(
  {
    id,
    destination,
    entry: advice,
    admission: advice,
    follow: SpaceEntryFollowSchema,
  },
  closed,
);
export const SpaceEntryPageSchema = t.Object(
  {
    reader: t.Union([id, t.Null()]),
    rows: t.Array(SpaceEntryRowSchema, { maxItems: 100 }),
  },
  closed,
);
export type SpaceEntryPresentation = Static<typeof SpaceEntryPresentationSchema>;
export type SpaceEntryFollow = Static<typeof SpaceEntryFollowSchema>;
export type SpaceEntryRow = Static<typeof SpaceEntryRowSchema>;
export type SpaceEntryPage = Static<typeof SpaceEntryPageSchema>;
/** Native observations stay inside the request. Bindings are never response fields. */
export type SpaceEntryCard = Readonly<{
  id: string;
  address: string | null;
  title: string;
  description: string;
  realmId: string | null;
  realmTitle: string | null;
  binding: string;
  presentation: SpaceEntryPresentation;
  destination: FollowingSpaceDestination;
  actions: FollowingSpaceActions;
}>;
