import {
  MediaImportRequestSchema,
  MediaImportAcceptedSchema,
  MediaImportStatusSchema,
  checkMediaImportRequest,
  checkMediaImportStatus,
} from '@rezics/definitions/media-import';
import { DocumentSnapshotSchema, type DocumentSnapshot } from '@rezics/document';
import { t } from 'elysia';
import type { Static, TSchema } from 'typebox';
import { Compile } from 'typebox/compile';
import type { BoardView, ItemView, ThreadView } from './model.ts';

/** Validate the published TypeBox shape without Elysia removing unknown input or response fields. */
export function strictContentSchema<S extends TSchema>(
  schema: S,
  check?: (value: unknown) => readonly { pointer: string; code: string }[],
) {
  const validator = Compile(schema);
  return {
    '~standard': {
      version: 1 as const,
      vendor: 'typebox',
      types: undefined as { input: Static<S>; output: Static<S> } | undefined,
      validate(value: unknown) {
        return (check ? check(value).length === 0 : validator.Check(value))
          ? { value: value as Static<S> }
          : { issues: [{ message: 'Value does not match the content schema' }] };
      },
      jsonSchema: { input: () => schema, output: () => schema },
    },
  };
}

const closed = { additionalProperties: false } as const;
export const SourceFenceQuerySchema = t.Object(
  {
    source: t.String({ minLength: 1, maxLength: 32, pattern: '^[a-z][a-z0-9_-]{0,31}$' }),
    externalId: t.String({ minLength: 1, maxLength: 1024, pattern: '^[^\\u0000-\\u001f\\u007f-\\u009f]+$' }),
    fieldGroup: t.Union([t.Literal('facts'), t.Literal('summary'), t.Literal('cover')]),
  },
  closed,
);
export const SourceFenceResponseSchema = t.Object(
  {
    fenced: t.Boolean(),
    securityRevision: t.Union([t.String({ pattern: '^[1-9][0-9]*$' }), t.Null()]),
  },
  closed,
);
export const ContentIdSchema = t.String({
  pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[78][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
});
const nullableId = t.Union([ContentIdSchema, t.Null()]);
const subjects = t.Array(ContentIdSchema, { maxItems: 128, uniqueItems: true });
const media = t.Array(ContentIdSchema, { maxItems: 32, uniqueItems: true });
const licence = t.String({ minLength: 1, maxLength: 128 });
const document = t.Unsafe<DocumentSnapshot>(DocumentSnapshotSchema);
const visibility = t.Union(['published', 'draft', 'protected', 'taken_down'].map((value) => t.Literal(value)));
const availability = t.Union([t.Literal('available'), t.Literal('erased')]);
const metadata = {
  id: ContentIdSchema,
  route: t.Integer({ minimum: 0, maximum: 65535 }),
  visibility,
  securityRevision: t.String({ pattern: '^[1-9][0-9]*$' }),
  createdAt: t.String({ format: 'date-time' }),
};
const references = { licence, subjectIds: subjects, boardId: ContentIdSchema };
const item = {
  ...metadata,
  ...references,
  threadId: ContentIdSchema,
  authorId: ContentIdSchema,
  parentId: nullableId,
  revisionId: ContentIdSchema,
  sha256: t.String({ pattern: '^[0-9a-f]{64}$' }),
  mediaIds: media,
};

/** The erased variant cannot carry authored bytes, even to an authorized reader. */
export const ItemViewSchema = t.Unsafe<ItemView>(
  t.Union([
    t.Object({ ...item, availability: t.Literal('available'), body: document }, closed),
    t.Object({ ...item, availability: t.Literal('erased'), body: t.Null() }, closed),
  ]),
);
export const ThreadViewSchema = t.Unsafe<ThreadView>(
  t.Object(
    {
      ...metadata,
      ...references,
      authorId: ContentIdSchema,
      title: t.Union([t.String(), t.Null()]),
      availability,
      firstPost: ItemViewSchema,
    },
    closed,
  ),
);
export const BoardViewSchema = t.Unsafe<BoardView>(
  t.Object({ ...metadata, title: t.Union([t.String(), t.Null()]), availability }, closed),
);
export const ThreadInputSchema = t.Object(
  {
    title: t.String({ minLength: 1, maxLength: 1024 }),
    body: document,
    ...references,
    visibility: t.Union([t.Literal('published'), t.Literal('draft')]),
  },
  closed,
);
export const PostInputSchema = t.Object(
  {
    body: document,
    licence,
    parentId: t.Optional(nullableId),
    subjectIds: t.Optional(subjects),
    boardId: t.Optional(ContentIdSchema),
    mediaIds: t.Optional(media),
  },
  closed,
);
export const RevisionInputSchema = t.Object(
  {
    body: document,
    licence: t.Optional(licence),
    subjectIds: t.Optional(subjects),
    boardId: t.Optional(ContentIdSchema),
    mediaIds: t.Optional(media),
  },
  closed,
);
export const ContentPageQuerySchema = t.Object(
  {
    cursor: t.Optional(t.String({ minLength: 1, maxLength: 4096 })),
    limit: t.Optional(t.Numeric({ minimum: 1, maximum: 100, multipleOf: 1 })),
  },
  closed,
);
export const ThreadResponseSchema = t.Object({ thread: ThreadViewSchema }, closed);
export const PostResponseSchema = t.Object({ post: ItemViewSchema }, closed);
export const BoardResponseSchema = t.Object({ board: BoardViewSchema }, closed);
export const PostPageResponseSchema = t.Object(
  { posts: t.Array(ItemViewSchema, { maxItems: 100 }), next: t.Union([t.String(), t.Null()]) },
  closed,
);
export const RevisionPageResponseSchema = t.Object(
  { revisions: t.Array(ItemViewSchema, { maxItems: 100 }), next: t.Union([t.String(), t.Null()]) },
  closed,
);

// Portable semantic validators include the shared bulk Rights checks. The exact
// portable schema also supplies OpenAPI; Elysia must not strip unknown members.
export const MediaImportInputSchema = strictContentSchema(MediaImportRequestSchema, checkMediaImportRequest);
export const MediaImportReceiptSchema = strictContentSchema(MediaImportAcceptedSchema);
export const MediaImportPollSchema = strictContentSchema(MediaImportStatusSchema, checkMediaImportStatus);
export const BoardThreadsQuerySchema = t.Object(
  {
    ...ContentPageQuerySchema.properties,
    sort: t.Optional(t.Union([t.Literal('newest'), t.Literal('oldest')])),
    query: t.Optional(t.String({ maxLength: 4096 })),
  },
  closed,
);
export const BoardThreadsResponseSchema = t.Object(
  { threads: t.Array(ThreadViewSchema, { maxItems: 100 }), next: t.Union([t.String(), t.Null()]) },
  closed,
);

const mediaDigest = t.String({ pattern: '^[0-9a-f]{64}$' });
const mediaLength = t.Integer({ minimum: 1, maximum: 20 * 1024 * 1024 });
const reservationRequestId = t.String({ minLength: 1, maxLength: 255 });
export const MediaReservationInputSchema = t.Object(
  {
    containerId: ContentIdSchema,
    purpose: t.Literal('post-image'),
    mediaType: t.Union([
      t.Literal('image/avif'),
      t.Literal('image/gif'),
      t.Literal('image/jpeg'),
      t.Literal('image/png'),
      t.Literal('image/webp'),
    ]),
    byteCount: mediaLength,
    sha256: t.Optional(mediaDigest),
  },
  closed,
);
export const MediaCompletionInputSchema = t.Object(
  {
    containerId: ContentIdSchema,
    reservationRequestId,
    byteCount: mediaLength,
    sha256: mediaDigest,
  },
  closed,
);
export const MediaReservationResponseSchema = t.Object(
  {
    media: t.Object(
      {
        id: ContentIdSchema,
        state: t.Union([
          t.Literal('reserved'),
          t.Literal('uploaded'),
          t.Literal('available'),
          t.Literal('rejected'),
          t.Literal('erased'),
        ]),
        byteCount: mediaLength,
        mediaType: t.String(),
        sha256: t.Union([mediaDigest, t.Null()]),
        containerId: ContentIdSchema,
        uploaderId: ContentIdSchema,
        key: t.String(),
        reservationRequestId,
      },
      closed,
    ),
  },
  closed,
);
export const MediaCompletionResponseSchema = t.Object(
  {
    media: t.Object({ id: ContentIdSchema, state: t.Literal('uploaded') }, closed),
  },
  closed,
);
export const MediaDownloadQuerySchema = t.Object({ variant: t.String({ minLength: 1, maxLength: 32 }) }, closed);
export const MediaDownloadResponseSchema = t.Object(
  {
    allowed: t.Literal(true),
    key: t.String(),
    sha256: mediaDigest,
    mediaType: t.String(),
    byteCount: t.Integer({ minimum: 1 }),
    publicCache: t.Literal(false),
    cacheControl: t.Union([t.Literal('private, no-cache'), t.Literal('private, no-store')]),
  },
  closed,
);
