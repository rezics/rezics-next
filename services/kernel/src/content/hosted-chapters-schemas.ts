import { t } from 'elysia';
import { MAX_DOCUMENT_BYTES } from './document.ts';
import { HOSTED_PLACEMENT_LIMIT, HOSTED_PAGE_LIMIT } from './hosted-chapters-model.ts';

const closed = { additionalProperties: false } as const;
export const HostedIdSchema = t.String({
  pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[78][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
});
const nullableId = t.Union([HostedIdSchema, t.Null()]);
const digest = t.String({ pattern: '^[0-9a-f]{64}$' });
const title = t.String({ minLength: 1, maxLength: 256 });
const target = t.Object(
  {
    threadId: HostedIdSchema,
    postId: HostedIdSchema,
    revisionId: HostedIdSchema,
    sha256: digest,
  },
  closed,
);
const address = {
  occurrenceId: HostedIdSchema,
  parentId: nullableId,
  position: t.Integer({ minimum: 0, maximum: HOSTED_PLACEMENT_LIMIT - 1 }),
};
const placement = t.Union([
  t.Object({ ...address, title, kind: t.Literal('part') }, closed),
  t.Object({ ...address, title, kind: t.Literal('chapter'), target }, closed),
]);
const placements = t.Array(placement, { maxItems: HOSTED_PLACEMENT_LIMIT });
export const HostedCreateSchema = t.Object({ postId: HostedIdSchema, threadId: HostedIdSchema, placements }, closed);
export const HostedReviseSchema = t.Object({ expectedRevisionId: HostedIdSchema, placements }, closed);
export const HostedPublishSchema = t.Object(
  {
    expectedRevisionId: HostedIdSchema,
    expectedPublicationId: nullableId,
    occurrenceIds: t.Array(HostedIdSchema, { maxItems: HOSTED_PLACEMENT_LIMIT, uniqueItems: true }),
  },
  closed,
);
export const HostedCommandSchema = t.Object({ catalogueId: HostedIdSchema, revisionId: HostedIdSchema }, closed);
const revision = {
  catalogueId: HostedIdSchema,
  revisionId: HostedIdSchema,
  kind: t.Union([t.Literal('structure'), t.Literal('publication')]),
  sourceRevisionId: nullableId,
};
export const HostedRevisionSchema = t.Object(revision, closed);
const occurrence = t.Union([
  t.Object(
    { ...address, kind: t.Union([t.Literal('part'), t.Literal('chapter')]), availability: t.Literal('unavailable') },
    closed,
  ),
  t.Object(
    { ...address, kind: t.Literal('part'), availability: t.Literal('available'), title, target: t.Null() },
    closed,
  ),
  t.Object({ ...address, kind: t.Literal('chapter'), availability: t.Literal('available'), title, target }, closed),
]);
export const HostedPageSchema = t.Object(
  {
    ...revision,
    items: t.Array(occurrence, { maxItems: HOSTED_PAGE_LIMIT }),
    nextCursor: t.Union([t.String({ maxLength: 4096 }), t.Null()]),
  },
  closed,
);
export const HostedResolutionSchema = t.Object(
  {
    ...revision,
    occurrence,
    document: t.Union([
      t.Null(),
      t.Object(
        {
          encoding: t.Literal('base64'),
          canonicalBytes: t.String({ maxLength: Math.ceil(MAX_DOCUMENT_BYTES / 3) * 4 }),
          sha256: digest,
          authorId: HostedIdSchema,
          licence: t.String({ minLength: 1, maxLength: 128 }),
        },
        closed,
      ),
    ]),
  },
  closed,
);
const selection = {
  revisionId: t.Optional(HostedIdSchema),
  kind: t.Optional(t.Union([t.Literal('structure'), t.Literal('publication')])),
};
const paging = {
  ...selection,
  cursor: t.Optional(t.String({ minLength: 1, maxLength: 4096 })),
  limit: t.Optional(t.String({ pattern: '^(?:[1-9]|1[0-9]|20)$' })),
};
export const HostedSelectionSchema = t.Object(selection, closed);
export const HostedChildrenQuerySchema = t.Object({ ...paging, parentId: t.Optional(HostedIdSchema) }, closed);
export const HostedNavigationQuerySchema = t.Object(
  { ...paging, direction: t.Union([t.Literal('previous'), t.Literal('next')]) },
  closed,
);

const ownerScope = t.Object(
  {
    kind: t.Literal('same-home'),
    route: t.Integer({ minimum: 0, maximum: 65535 }),
    crossHome: t.Literal('unavailable'),
  },
  closed,
);
const ownerViewer = t.Object({ accountId: HostedIdSchema, authnEpoch: t.Integer({ minimum: 0 }) }, closed);
const ownerEntry = t.Object(
  {
    catalogueId: HostedIdSchema,
    threadId: HostedIdSchema,
    createdAt: t.String({ format: 'date-time' }),
    postRevisionId: HostedIdSchema,
    postVisibility: t.Union([t.Literal('draft'), t.Literal('published'), t.Literal('protected')]),
    headRevisionId: HostedIdSchema,
    publicationId: nullableId,
  },
  closed,
);
export const HostedOwnerInventoryQuerySchema = t.Object(
  {
    scope: t.Optional(t.Union([t.Literal('same-home'), t.Literal('all-homes')])),
    cursor: t.Optional(t.String({ minLength: 1, maxLength: 4096 })),
    limit: t.Optional(t.String({ pattern: '^(?:[1-9]|1[0-9]|20)$' })),
  },
  closed,
);
export const HostedOwnerInventorySchema = t.Object(
  {
    scope: ownerScope,
    viewer: ownerViewer,
    items: t.Array(ownerEntry, { maxItems: HOSTED_PAGE_LIMIT }),
    nextCursor: t.Union([t.String({ maxLength: 4096 }), t.Null()]),
  },
  closed,
);
export const HostedOwnerInventoryReadSchema = t.Object(
  { scope: ownerScope, viewer: ownerViewer, item: ownerEntry },
  closed,
);
