import {
  MediaImportRequestSchema,
  MediaImportAcceptedSchema,
  MediaImportStatusSchema,
  CoverCreditSchema,
  checkMediaImportRequest,
  checkMediaImportStatus,
} from '@rezics/definitions/media-import';
import { DocumentSnapshotSchema, type DocumentSnapshot } from '@rezics/document';
import { t } from 'elysia';
import type { Static, TSchema } from 'typebox';
import { Compile } from 'typebox/compile';
import { CommunityPresentationSchema } from './community-presentation-model.ts';
export { CommunityPresentationSchema } from './community-presentation-model.ts';
import { REACTION_KINDS } from './events.ts';
import { MAX_RATING_STORED_UNITS } from '../rating/question-scale.ts';
import type { AuthorPostEntry } from './author-item-reads.ts';
import type { BoardView } from './model.ts';
import type { ItemView, PostEntry, ThreadView } from './reads.ts';
import type { ReporterReportView, ReportReadView, ReportView } from './reports.ts';
import type { Operation } from './operation-contract.ts';
import type { DocumentMediaPage } from './media-presentation.ts';

type ViewerReactionKind = (typeof REACTION_KINDS)[number];
type ViewerReactionSlot = { readonly viewerReaction?: ViewerReactionKind | null };
type ReactionCountMap = { readonly [kind in ViewerReactionKind]?: number };
type ReactionCountsSlot = { readonly reactions?: ReactionCountMap };

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
const reportTarget = t.Object(
  {
    kind: t.Union([t.Literal('board'), t.Literal('thread'), t.Literal('post'), t.Literal('subject'), t.Literal('space'), t.Literal('realm')]),
    id: ContentIdSchema,
  },
  closed,
);
const reportReason = t.Union([
  t.Literal('off_topic'),
  t.Literal('inappropriate'),
  t.Literal('spam'),
  t.Literal('illegal'),
  t.Literal('other'),
]);
const reportInput = {
  target: reportTarget,
  revisionId: t.Optional(ContentIdSchema),
  botToken: t.Optional(t.String({ minLength: 1, maxLength: 2048 })),
};
export const ReportInputSchema = t.Object(
  {
    ...reportInput,
    reason: reportReason,
    evidence: t.Optional(t.String({ maxLength: 4096 })),
  },
  {
    ...closed,
    allOf: [
      {
        if: { properties: { reason: { enum: ['illegal', 'other'] } }, required: ['reason'] },
        then: { required: ['evidence'], properties: { evidence: { type: 'string', minLength: 1 } } },
      },
    ],
  },
);
export const ReportReceiptSchema = t.Object({ reportId: ContentIdSchema }, closed);
const ModeratorReportResponseSchema = t.Object(
  {
    report: t.Unsafe<ReportView>(
      t.Object(
        {
          id: ContentIdSchema,
          partition: t.Integer({ minimum: 0, maximum: 4095 }),
          target: reportTarget,
          revisionId: nullableId,
          reason: reportReason,
          evidence: t.Union([t.String({ maxLength: 4096 }), t.Null()]),
          reporterId: nullableId,
          outcome: t.Union([t.Literal('actioned'), t.Literal('dismissed'), t.Null()]),
          resolvedAt: t.Union([t.String({ format: 'date-time' }), t.Null()]),
          createdAt: t.String({ format: 'date-time' }),
          transactionId: t.String({ format: 'uuid' }),
        },
        closed,
      ),
    ),
  },
  closed,
);
const reporterReport = t.Unsafe<ReporterReportView>(
  t.Object(
    {
      id: ContentIdSchema,
      target: reportTarget,
      revisionId: nullableId,
      reason: reportReason,
      evidence: t.Union([t.String({ maxLength: 4096 }), t.Null()]),
      reporterId: ContentIdSchema,
      outcome: t.Union([t.Literal('actioned'), t.Literal('dismissed'), t.Null()]),
      resolvedAt: t.Union([t.String({ format: 'date-time' }), t.Null()]),
      createdAt: t.String({ format: 'date-time' }),
      targetAvailability: t.Union([t.Literal('available'), t.Literal('unavailable')]),
    },
    closed,
  ),
);
export const ReportResponseSchema = t.Object(
  {
    report: t.Unsafe<ReportReadView>(t.Union([reporterReport, ModeratorReportResponseSchema.properties.report])),
  },
  closed,
);

const subjects = t.Array(ContentIdSchema, { maxItems: 128, uniqueItems: true });
const media = t.Array(ContentIdSchema, { maxItems: 32, uniqueItems: true });
const voteCitation = t.Object(
  {
    questionId: ContentIdSchema,
    units: t.Integer({ minimum: 0, maximum: MAX_RATING_STORED_UNITS }),
    revision: t.Integer({ minimum: 1, maximum: 2_147_483_647 }),
  },
  closed,
);
const licence = t.String({ minLength: 1, maxLength: 128 });
const document = t.Unsafe<DocumentSnapshot>(DocumentSnapshotSchema);
const visibility = t.Union(['published', 'draft', 'protected', 'taken_down'].map((value) => t.Literal(value)));
const reactionKind = t.Unsafe<ViewerReactionKind>(t.Union(REACTION_KINDS.map((kind) => t.Literal(kind))));
const subjectReactionKinds = ['like', 'love', 'laugh', 'insightful', 'sad'] as const;
const subjectReactionKind = t.Unsafe<(typeof subjectReactionKinds)[number]>(
  t.Union(subjectReactionKinds.map((kind) => t.Literal(kind))),
);
const viewerReaction = { viewerReaction: t.Optional(t.Union([reactionKind, t.Null()])) };
const reactionCount = t.Integer({ minimum: 1 });
const reactions = {
  reactions: t.Optional(
    t.Object(
      {
        upvote: t.Optional(reactionCount),
        downvote: t.Optional(reactionCount),
        like: t.Optional(reactionCount),
        love: t.Optional(reactionCount),
        laugh: t.Optional(reactionCount),
        insightful: t.Optional(reactionCount),
        sad: t.Optional(reactionCount),
      },
      closed,
    ),
  ),
};
const reactionFreshness = t.Union([
  t.Object({ epoch: t.Integer({ minimum: 1 }), position: t.String({ pattern: '^[1-9][0-9]*$' }) }, closed),
  t.Null(),
]);
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
  voteCitation: t.Union([voteCitation, t.Null()]),
  revisedAt: t.Union([t.String({ format: 'date-time' }), t.Null()]),
  ...viewerReaction,
  ...reactions,
};

/** The erased variant cannot carry authored bytes, even to an authorized reader. */
export const ItemViewSchema = t.Unsafe<ItemView & ViewerReactionSlot & ReactionCountsSlot>(
  t.Union([
    t.Object({ ...item, availability: t.Literal('available'), body: document }, closed),
    t.Object(
      {
        ...item,
        availability: t.Literal('erased'),
        removed: t.Literal(true),
        body: t.Null(),
        sha256: t.Null(),
        restorableUntil: t.Optional(t.String({ format: 'date-time' })),
      },
      closed,
    ),
  ]),
);
export const ErasedPlaceholderSchema = t.Object(
  {
    id: ContentIdSchema,
    threadId: ContentIdSchema,
    route: metadata.route,
    parentId: nullableId,
    removed: t.Literal(true),
    availability: t.Literal('erased'),
    restorableUntil: t.Optional(t.String({ format: 'date-time' })),
    body: t.Null(),
    sha256: t.Null(),
  },
  closed,
);
export const PostEntrySchema = t.Unsafe<PostEntry & ViewerReactionSlot & ReactionCountsSlot>(
  t.Union([
    ItemViewSchema,
    ErasedPlaceholderSchema,
    t.Object(
      {
        ...item,
        availability: t.Literal('withheld'),
        removed: t.Literal(true),
        body: t.Null(),
        sha256: t.Null(),
        decisionId: t.Optional(ContentIdSchema),
      },
      closed,
    ),
  ]),
);
export const ThreadViewSchema = t.Unsafe<ThreadView & ViewerReactionSlot & ReactionCountsSlot>(
  t.Object(
    {
      ...metadata,
      ...references,
      authorId: ContentIdSchema,
      kind: t.Union([t.Literal('discussion'), t.Literal('review')]),
      title: t.Union([t.String(), t.Null()]),
      availability,
      firstPost: PostEntrySchema,
      ...viewerReaction,
      ...reactions,
    },
    closed,
  ),
);
export const BoardViewSchema = t.Unsafe<BoardView>(
  t.Object(
    {
      ...metadata,
      realmId: nullableId,
      community: t.Union([CommunityPresentationSchema, t.Null()]),
      title: t.Union([t.String(), t.Null()]),
      purpose: t.Union([t.Literal('discussion'), t.Literal('reviews')]),
      availability,
    },
    closed,
  ),
);
export const ThreadInputSchema = t.Object(
  {
    kind: t.Optional(t.Union([t.Literal('discussion'), t.Literal('review')])),
    title: t.String({ minLength: 1, maxLength: 1024 }),
    body: document,
    ...references,
    visibility: t.Union([t.Literal('published'), t.Literal('draft'), t.Literal('protected')]),
    mediaIds: t.Optional(media),
    voteCitation: t.Optional(voteCitation),
  },
  closed,
);
export const PostInputSchema = t.Object(
  {
    visibility: t.Optional(t.Union([t.Literal('published'), t.Literal('draft'), t.Literal('protected')])),
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
    title: t.Optional(t.String({ minLength: 1, maxLength: 1024 })),
    visibility: t.Optional(t.Union([t.Literal('published'), t.Literal('draft')])),
    body: document,
    licence: t.Optional(licence),
    subjectIds: t.Optional(subjects),
    boardId: t.Optional(ContentIdSchema),
    mediaIds: t.Optional(media),
    voteCitation: t.Optional(voteCitation),
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
export const ReactionInputSchema = t.Object({ kind: reactionKind }, closed);
export const ReactionResponseSchema = t.Object({ kind: reactionKind }, closed);
export const SubjectReactionInputSchema = t.Object({ kind: subjectReactionKind }, closed);
export const SubjectReactionResponseSchema = t.Object({ kind: subjectReactionKind }, closed);
export const SubjectOwnReactionResponseSchema = t.Object({ kind: t.Union([subjectReactionKind, t.Null()]) }, closed);
export const SubjectReactionRedirectResponseSchema = t.Object(
  {
    redirect: t.Object({ from: ContentIdSchema, to: ContentIdSchema }, closed),
  },
  closed,
);
export const ThreadResponseSchema = t.Object(
  {
    thread: ThreadViewSchema,
    reactionsAsOf: t.Optional(reactionFreshness),
    authorErasure: t.Optional(t.Object({ authorId: ContentIdSchema, mayErase: t.Boolean() }, closed)),
  },
  closed,
);
export const PostResponseSchema = t.Object({ post: PostEntrySchema }, closed);
export const BoardResponseSchema = t.Object({ board: BoardViewSchema }, closed);
export const GlobalBoardDirectoryQuerySchema = t.Object(
  {
    purpose: t.Optional(t.Union([t.Literal('discussion'), t.Literal('reviews')])),
    cursor: t.Optional(t.String({ minLength: 1, maxLength: 4096 })),
    limit: t.Optional(t.Numeric({ minimum: 1, maximum: 100, multipleOf: 1 })),
  },
  closed,
);
export const GlobalBoardDirectoryResponseSchema = t.Object(
  { boards: t.Array(BoardViewSchema, { maxItems: 100 }), next: t.Union([t.String(), t.Null()]) },
  closed,
);
export const PostPageResponseSchema = t.Object(
  {
    posts: t.Array(PostEntrySchema, { maxItems: 100 }),
    next: t.Union([t.String(), t.Null()]),
    reactionsAsOf: t.Optional(reactionFreshness),
  },
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
    sort: t.Optional(t.Union([t.Literal('newest'), t.Literal('oldest'), t.Literal('active'), t.Literal('hot')])),
    query: t.Optional(t.String({ maxLength: 4096 })),
  },
  closed,
);
export const BoardThreadsResponseSchema = t.Object(
  {
    pinnedThreads: t.Array(ThreadViewSchema, { maxItems: 5 }),
    threads: t.Array(ThreadViewSchema, { maxItems: 100 }),
    next: t.Union([t.String(), t.Null()]),
    rankRefreshedAt: t.Union([t.String({ format: 'date-time' }), t.Null()]),
  },
  closed,
);
export const BoardThreadPinInputSchema = t.Object({ pinned: t.Boolean() }, closed);
export const BoardThreadPinResponseSchema = t.Object(
  {
    boardId: ContentIdSchema,
    threadId: ContentIdSchema,
    pinned: t.Boolean(),
    pinPosition: t.Union([t.Integer({ minimum: 1, maximum: 5 }), t.Null()]),
  },
  closed,
);
/** The shared sitemap feed shape: every feed pages with an opaque cursor and lists items that carry `lastModified`. */
export const SitemapQuerySchema = t.Object(
  {
    cursor: t.Optional(t.String({ minLength: 1, maxLength: 4096 })),
    limit: t.Optional(t.Numeric({ minimum: 1, maximum: 1000, multipleOf: 1 })),
  },
  closed,
);
export const sitemapLastModified = t.String({ format: 'date-time' });
export function sitemapPageSchema<Item extends TSchema>(item: Item) {
  return t.Object({ items: t.Array(item, { maxItems: 1000 }), next: t.Union([t.String(), t.Null()]) }, closed);
}
export const SitemapBoardItemSchema = t.Object({ id: ContentIdSchema, lastModified: sitemapLastModified }, closed);
export const SitemapThreadItemSchema = t.Object(
  { id: ContentIdSchema, title: t.Union([t.String(), t.Null()]), lastModified: sitemapLastModified },
  closed,
);
export const SitemapBoardPageSchema = sitemapPageSchema(SitemapBoardItemSchema);
export const SitemapThreadPageSchema = sitemapPageSchema(SitemapThreadItemSchema);
export const SubjectThreadsQuerySchema = t.Object(
  {
    place: ContentIdSchema,
    kind: t.Union([t.Literal('discussion'), t.Literal('review')]),
    cursor: t.Optional(t.String({ minLength: 1, maxLength: 4096 })),
    limit: t.Optional(t.Numeric({ minimum: 1, maximum: 20, multipleOf: 1 })),
  },
  closed,
);
export const SubjectThreadsResponseSchema = t.Object(
  {
    threads: t.Array(ThreadViewSchema, { maxItems: 20 }),
    next: t.Union([t.String(), t.Null()]),
  },
  closed,
);

export const AuthorPostsQuerySchema = t.Object(
  {
    cursor: t.Optional(t.String({ minLength: 1, maxLength: 4096 })),
    limit: t.Optional(t.Numeric({ minimum: 1, maximum: 20, multipleOf: 1 })),
  },
  closed,
);
export const AuthorThreadsQuerySchema = t.Object(
  {
    ...AuthorPostsQuerySchema.properties,
    kind: t.Optional(t.Union([t.Literal('discussion'), t.Literal('review')])),
  },
  closed,
);
export const AuthorThreadsResponseSchema = SubjectThreadsResponseSchema;
export const AuthorPostsResponseSchema = t.Object(
  {
    posts: t.Array(
      t.Unsafe<AuthorPostEntry>(
        t.Object(
          {
            ...item,
            availability: t.Literal('available'),
            body: document,
            thread: t.Object({ id: ContentIdSchema, title: t.Union([t.String(), t.Null()]) }, closed),
          },
          closed,
        ),
      ),
      { maxItems: 20 },
    ),
    next: t.Union([t.String(), t.Null()]),
  },
  closed,
);

const mediaDigest = t.String({ pattern: '^[0-9a-f]{64}$' });
const mediaLength = t.Integer({ minimum: 1, maximum: 20 * 1024 * 1024 });
const imageDimension = t.Integer({ minimum: 1 });
export const DocumentMediaInputSchema = t.Object(
  {
    ids: t.Array(t.Intersect([ContentIdSchema, t.String({ minLength: 36, maxLength: 36 })]), {
      minItems: 1,
      maxItems: 32,
      uniqueItems: true,
    }),
  },
  closed,
);
export const DocumentMediaPageSchema = t.Unsafe<DocumentMediaPage>(
  t.Object(
    {
      images: t.Array(
        t.Object(
          {
            id: ContentIdSchema,
            containerId: ContentIdSchema,
            digest: mediaDigest,
            width: imageDimension,
            height: imageDimension,
            variants: t.Array(
              t.Object(
                {
                  format: t.Union([t.Literal('avif'), t.Literal('webp')]),
                  width: t.Integer({ minimum: 1, maximum: 2560 }),
                  height: imageDimension,
                },
                closed,
              ),
              { minItems: 1, maxItems: 12 },
            ),
            placeholder: t.Union([
              t.Object(
                {
                  thumbhash: t.String({ minLength: 1, maxLength: 44 }),
                  color: t.String({ pattern: '^#[0-9a-f]{6}$' }),
                },
                closed,
              ),
              t.Null(),
            ]),
            focalPoint: t.Union([
              t.Object(
                {
                  x: t.Number({ minimum: 0, maximum: 1 }),
                  y: t.Number({ minimum: 0, maximum: 1 }),
                },
                closed,
              ),
              t.Null(),
            ]),
            credit: t.Union([CoverCreditSchema, t.Null()]),
          },
          closed,
        ),
        { maxItems: 32 },
      ),
    },
    closed,
  ),
);
const reservationRequestId = t.String({ minLength: 1, maxLength: 255 });
const mediaReservationFields = {
  mediaType: t.Union([
    t.Literal('image/avif'),
    t.Literal('image/gif'),
    t.Literal('image/jpeg'),
    t.Literal('image/png'),
    t.Literal('image/webp'),
  ]),
  byteCount: mediaLength,
  sha256: t.Optional(mediaDigest),
};
export const MediaReservationInputSchema = t.Union([
  t.Object(
    {
      containerId: ContentIdSchema,
      purpose: t.Union([t.Literal('post-image'), t.Literal('avatar')]),
      ...mediaReservationFields,
    },
    closed,
  ),
  t.Object(
    {
      newThread: t.Object({ boardId: ContentIdSchema, idempotencyKey: reservationRequestId }, closed),
      purpose: t.Literal('post-image'),
      ...mediaReservationFields,
    },
    closed,
  ),
]);
export const RealmMediaReservationInputSchema = t.Object(
  { purpose: t.Union([t.Literal('realm-icon'), t.Literal('realm-banner')]), ...mediaReservationFields },
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
const mediaReservationMetadata = t.Object(
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
);
export const MediaReservationResponseSchema = t.Object(
  {
    media: t.Union([
      mediaReservationMetadata,
      t.Object(
        {
          ...mediaReservationMetadata.properties,
          purpose: t.Union([t.Literal('avatar'), t.Literal('realm-icon'), t.Literal('realm-banner')]),
        },
        closed,
      ),
    ]),
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

/** Only report lists accept these selectors; unrelated content pages remain unchanged. */
export const ReportPageQuerySchema = t.Object(
  {
    cursor: t.Optional(t.String({ minLength: 1, maxLength: 4096 })),
    limit: t.Optional(t.Numeric({ minimum: 1, maximum: 100, multipleOf: 1 })),
    status: t.Optional(t.Union([t.Literal('all'), t.Literal('pending'), t.Literal('resolved')])),
    targetKind: t.Optional(
      t.Union([t.Literal('all'), t.Literal('board'), t.Literal('thread'), t.Literal('post'), t.Literal('subject'), t.Literal('space'), t.Literal('realm')]),
    ),
    order: t.Optional(t.Union([t.Literal('newest'), t.Literal('oldest')])),
  },
  closed,
);

export const ReportPageResponseSchema = t.Object(
  {
    reports: t.Array(ModeratorReportResponseSchema.properties.report, { maxItems: 100 }),
    next: t.Union([t.String(), t.Null()]),
  },
  closed,
);

export const CatalogueReportPageQuerySchema = t.Object(
  {
    ...ReportPageQuerySchema.properties,
    limit: t.Optional(t.Numeric({ minimum: 1, maximum: 50, multipleOf: 1 })),
  },
  closed,
);
export const CatalogueReportPageResponseSchema = t.Object(
  {
    ...ReportPageResponseSchema.properties,
    reports: t.Array(ModeratorReportResponseSchema.properties.report, { maxItems: 50 }),
  },
  closed,
);

export const ModerationReasonSchema = t.Object({ reason: t.String({ minLength: 1, maxLength: 1024 }) }, closed);
export const ModerationResponseSchema = t.Object({ securityRevision: t.String({ pattern: '^[1-9][0-9]*$' }) }, closed);
export const AuthorErasureInputSchema = t.Object({ authorId: ContentIdSchema }, closed);
const operationCount = t.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const operationCounts = { processedPosts: operationCount, erasedRevisions: operationCount };
const operationBase = {
  name: t.String({ pattern: '^operations/[0-9a-f-]{36}$' }),
  metadata: t.Object(
    {
      type: t.Literal('content.author_erasure'),
      threadId: ContentIdSchema,
      authorId: ContentIdSchema,
      ...operationCounts,
      steps: operationCount,
    },
    closed,
  ),
};
/** Pending has no result; a completed AIP-151 operation has exactly one arm. */
export const OperationSchema = t.Unsafe<Operation>(
  t.Union([
    t.Object({ ...operationBase, done: t.Literal(false) }, closed),
    t.Object({ ...operationBase, done: t.Literal(true), response: t.Object(operationCounts, closed) }, closed),
    t.Object(
      {
        ...operationBase,
        done: t.Literal(true),
        error: t.Object(
          {
            code: t.Integer({ minimum: 1, maximum: 16 }),
            message: t.String(),
            details: t.Optional(t.Array(t.Unknown())),
          },
          closed,
        ),
      },
      closed,
    ),
  ]),
);

export const ContentEditionInputSchema = t.Object(
  {
    postId: ContentIdSchema,
    revisionId: ContentIdSchema,
    targetSubjectId: ContentIdSchema,
  },
  closed,
);
export const EditionSubjectIdentitySchema = t.Object(
  {
    id: ContentIdSchema,
    kind: t.Union([t.Literal('available'), t.Literal('missing'), t.Literal('withheld')]),
    label: t.Union([t.Object({ value: t.String(), language: t.String() }, closed), t.Null()]),
  },
  closed,
);
export const EditionIdentitySchema = t.Object(
  {
    subject: EditionSubjectIdentitySchema,
    revisionCreatedAt: t.Union([t.String({ format: 'date-time' }), t.Null()]),
  },
  closed,
);
export const EditionSourceIdentitySchema = t.Object(
  {
    postId: ContentIdSchema,
    revisionId: ContentIdSchema,
    sha256: t.String({ pattern: '^[0-9a-f]{64}$' }),
    revisionCreatedAt: t.Union([t.String({ format: 'date-time' }), t.Null()]),
    subjects: t.Array(EditionSubjectIdentitySchema, { maxItems: 128 }),
  },
  closed,
);
export const ContentEditionSchema = t.Object(
  {
    editionId: ContentIdSchema,
    identity: t.Optional(EditionIdentitySchema),
    editionRevision: t.String({ pattern: '^[1-9][0-9]*$' }),
    state: t.Union([t.Literal('draft'), t.Literal('published'), t.Literal('withdrawn')]),
    targetSubjectId: ContentIdSchema,
    creatorAccountId: ContentIdSchema,
    revisionId: ContentIdSchema,
    sha256: t.String({ pattern: '^[0-9a-f]{64}$' }),
    licence: t.String(),
  },
  closed,
);
export const ContentEditionRevisionSchema = t.Object(
  {
    editionId: ContentIdSchema,
    revisionId: ContentIdSchema,
    sha256: t.String({ pattern: '^[0-9a-f]{64}$' }),
    licence: t.String(),
    body: DocumentSnapshotSchema,
  },
  closed,
);
export const ContentEditionCommandSchema = t.Object(
  {
    editionId: ContentIdSchema,
    editionRevision: t.String({ pattern: '^[1-9][0-9]*$' }),
  },
  closed,
);
