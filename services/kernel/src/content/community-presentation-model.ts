import type { DocumentSnapshot } from '@rezics/document';
import { DocumentSnapshotSchema } from '@rezics/document';
import { t } from 'elysia';
import {
  RealmPresentationImageSchema,
  type RealmPresentationImage,
  type RealmPresentationOptional,
} from './realm-media-schema.ts';

export type CommunityPresentation = Readonly<{
  realmId: string;
  spaceId: string;
  contextId: string;
  name: string;
  description: string;
  avatar: RealmPresentationOptional<RealmPresentationImage>;
  banner: RealmPresentationOptional<RealmPresentationImage>;
  members:
    | Readonly<{ state: 'current'; count: number; version: string }>
    | Readonly<{ state: 'unknown'; count: null; version: null }>;
  rules: RealmPresentationOptional<
    Readonly<{
      postId: string;
      revisionId: string;
      body: DocumentSnapshot;
      licence: string;
      sha256: string;
    }>
  >;
  join: Readonly<{ membership: 'member' | 'nonmember' | 'unknown'; action: 'join' | 'leave' | 'sign-in' | null }>;
}>;
const closed = { additionalProperties: false } as const;
const id = t.String({ format: 'uuid' });
const optional = <T extends import('typebox').TSchema>(schema: T) =>
  t.Union([
    t.Object({ state: t.Literal('available'), value: schema }, closed),
    t.Object({ state: t.Union([t.Literal('none'), t.Literal('unavailable')]), value: t.Null() }, closed),
  ]);
export const CommunityPresentationSchema = t.Object(
  {
    realmId: id,
    spaceId: id,
    contextId: id,
    name: t.String(),
    description: t.String(),
    avatar: optional(RealmPresentationImageSchema),
    banner: optional(RealmPresentationImageSchema),
    members: t.Union([
      t.Object(
        { state: t.Literal('current'), count: t.Integer({ minimum: 0 }), version: t.String({ minLength: 1 }) },
        closed,
      ),
      t.Object({ state: t.Literal('unknown'), count: t.Null(), version: t.Null() }, closed),
    ]),
    rules: optional(
      t.Object(
        {
          postId: id,
          revisionId: id,
          body: DocumentSnapshotSchema,
          licence: t.String(),
          sha256: t.String({ pattern: '^[0-9a-f]{64}$' }),
        },
        closed,
      ),
    ),
    join: t.Object(
      {
        membership: t.Union([t.Literal('member'), t.Literal('nonmember'), t.Literal('unknown')]),
        action: t.Union([t.Literal('join'), t.Literal('leave'), t.Literal('sign-in'), t.Null()]),
      },
      closed,
    ),
  },
  closed,
);

/** Materialize readonly derivative collections for the HTTP schema's JSON DTO. */
export function communityPresentationResponse(
  value: CommunityPresentation,
): import('typebox').Static<typeof CommunityPresentationSchema> {
  const imageResponse = (image: RealmPresentationOptional<RealmPresentationImage>) =>
    image.state === 'available'
      ? {
          state: image.state,
          value: { ...image.value, variants: image.value.variants.map((variant) => ({ ...variant })) },
        }
      : image;
  return { ...value, avatar: imageResponse(value.avatar), banner: imageResponse(value.banner) };
}
