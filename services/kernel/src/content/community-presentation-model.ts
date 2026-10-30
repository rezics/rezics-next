import type { DocumentSnapshot } from '@rezics/document';
import { DocumentSnapshotSchema } from '@rezics/document';
import { MediaImportRequestSchema } from '@rezics/definitions/media-import';
import { t } from 'elysia';
import type { RealmPresentationImage, RealmPresentationOptional } from './realm-media.ts';

export type CommunityPresentation = Readonly<{
  realmId: string; spaceId: string; contextId: string; name: string; description: string;
  avatar: RealmPresentationOptional<RealmPresentationImage>;
  banner: RealmPresentationOptional<RealmPresentationImage>;
  members: Readonly<{ state: 'current'; count: number; version: string }> |
    Readonly<{ state: 'unknown'; count: null; version: null }>;
  rules: RealmPresentationOptional<Readonly<{
    postId: string; revisionId: string; body: DocumentSnapshot; licence: string; sha256: string;
  }>>;
  join: Readonly<{ membership: 'member' | 'nonmember' | 'unknown'; action: 'join' | 'leave' | 'sign-in' | null }>;
}>;
const closed = { additionalProperties: false } as const;
const id = t.String({ format: 'uuid' });
const nullable = <T extends import('typebox').TSchema>(schema: T) => t.Union([schema, t.Null()]);
const optional = <T extends import('typebox').TSchema>(schema: T) => t.Union([
  t.Object({ state: t.Literal('available'), value: schema }, closed),
  t.Object({ state: t.Union([t.Literal('none'), t.Literal('unavailable')]), value: t.Null() }, closed),
]);
const image = t.Object({
  id, containerId: id, digest: t.String({ pattern: '^[0-9a-f]{64}$' }),
  width: t.Integer({ minimum: 1 }), height: t.Integer({ minimum: 1 }),
  variants: t.Array(t.Object({ format: t.Union([t.Literal('avif'), t.Literal('webp')]),
    width: t.Integer({ minimum: 1 }), height: t.Integer({ minimum: 1 }) }, closed), { minItems: 1, maxItems: 12 }),
  placeholder: nullable(t.Object({ thumbhash: t.String(), color: t.String() }, closed)),
  focalPoint: nullable(t.Object({ x: t.Number({ minimum: 0, maximum: 1 }), y: t.Number({ minimum: 0, maximum: 1 }) }, closed)),
  credit: nullable(MediaImportRequestSchema.properties.credit),
}, closed);
export const CommunityPresentationSchema = t.Object({
  realmId: id, spaceId: id, contextId: id, name: t.String(), description: t.String(),
  avatar: optional(image), banner: optional(image),
  members: t.Union([
    t.Object({ state: t.Literal('current'), count: t.Integer({ minimum: 0 }), version: t.String({ minLength: 1 }) }, closed),
    t.Object({ state: t.Literal('unknown'), count: t.Null(), version: t.Null() }, closed),
  ]),
  rules: optional(t.Object({ postId: id, revisionId: id, body: DocumentSnapshotSchema,
    licence: t.String(), sha256: t.String({ pattern: '^[0-9a-f]{64}$' }) }, closed)),
  join: t.Object({ membership: t.Union([t.Literal('member'), t.Literal('nonmember'), t.Literal('unknown')]),
    action: t.Union([t.Literal('join'), t.Literal('leave'), t.Literal('sign-in'), t.Null()]) }, closed),
}, closed);

/** Materialize readonly derivative collections for the HTTP schema's JSON DTO. */
export function communityPresentationResponse(value: CommunityPresentation): import('typebox').Static<typeof CommunityPresentationSchema> {
  const imageResponse = (image: RealmPresentationOptional<RealmPresentationImage>) => image.state === 'available'
    ? { state: image.state, value: { ...image.value, variants: image.value.variants.map((variant) => ({ ...variant })) } }
    : image;
  return { ...value, avatar: imageResponse(value.avatar), banner: imageResponse(value.banner) };
}
