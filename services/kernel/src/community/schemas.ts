import { REACTION_KINDS } from '../content/events.ts';
import { RealmPresentationSchema } from './presentation.ts';
import { t } from 'elysia';
import { RealmPresentationImageSchema } from '../content/realm-media.ts';
import { ContentIdSchema, sitemapPageSchema } from '../content/schemas.ts';

const closed = { additionalProperties: false } as const;
const instant = t.String({ format: 'date-time' });
const title = t.String({ minLength: 1, maxLength: 1024 });
const summary = t.String({ maxLength: 4096 });
const id = t.String({ format: 'uuid' });

export const realmClaimApprovalResponseSchema = t.Object(
  {
    claim: t.Object(
      {
        realmId: id,
        requestId: id,
        claimantAccountId: id,
        state: t.Literal('owned'),
        orphanedAt: t.String({ format: 'date-time' }),
        approvedAt: t.String({ format: 'date-time' }),
      },
      closed,
    ),
  },
  closed,
);

export const RealmClaimRequestInputSchema = t.Object({}, closed);
export const RealmClaimRequestSchema = t.Object(
  {
    realmId: id,
    requestId: id,
    state: t.Literal('pending'),
    orphanedAt: t.String({ format: 'date-time' }),
    claimEligibleAt: t.String({ format: 'date-time' }),
    requestedAt: t.String({ format: 'date-time' }),
  },
  closed,
);

export const SitemapCanonicalDestinationSchema = t.Union([
  t.Object({ kind: t.Literal('space'), spaceId: ContentIdSchema, address: t.String() }, closed),
  t.Object({ kind: t.Literal('realm'), realmId: ContentIdSchema }, closed),
]);

export const SitemapRealmItemSchema = t.Object(
  {
    id: ContentIdSchema,
    lastModified: t.String({ format: 'date-time' }),
    canonicalDestination: SitemapCanonicalDestinationSchema,
  },
  closed,
);
export const SitemapSpaceItemSchema = t.Object(
  {
    id: ContentIdSchema,
    address: t.String(),
    lastModified: t.String({ format: 'date-time' }),
  },
  closed,
);
export const SitemapRealmPageSchema = sitemapPageSchema(SitemapRealmItemSchema);
export const SitemapSpacePageSchema = sitemapPageSchema(SitemapSpaceItemSchema);

export const discoveryQuerySchema = t.Object(
  {
    sort: t.Union([t.Literal('popular'), t.Literal('trending')]),
    cursor: t.Optional(t.String({ minLength: 1, maxLength: 4096 })),
    limit: t.Optional(t.Integer({ minimum: 1, maximum: 100, default: 20 })),
  },
  closed,
);

export const discoveryResponseSchema = t.Object(
  {
    realms: t.Array(
      t.Object(
        {
          realmId: id,
          spaceId: id,
          name: t.String({ minLength: 1, maxLength: 1024 }),
          description: t.String({ maxLength: 160 }),
          avatar: t.Union([RealmPresentationImageSchema, t.Null()]),
        },
        closed,
      ),
      { maxItems: 20 },
    ),
    next: t.Union([t.String(), t.Null()]),
  },
  closed,
);

export const ownRealmsQuerySchema = t.Object({ cursor: t.Optional(t.String({ maxLength: 4096 })) }, closed);

/** Advice is an observation; commands still authorize every attempt before receipts. */
export const realmViewerActionSchema = t.Union([
  t.Object(
    {
      state: t.Literal('available'),
      method: t.Union([t.Literal('GET'), t.Literal('DELETE')]),
      path: t.String({ maxLength: 128 }),
      body: t.Null(),
      expectedStatus: t.Union([t.Literal(200), t.Literal(202)]),
    },
    closed,
  ),
  t.Object(
    {
      state: t.Literal('prohibited'),
      reason: t.Union([
        t.Literal('not_authorized'),
        t.Literal('not_member'),
        t.Literal('signed_out'),
        t.Literal('governance_read_only'),
      ]),
    },
    closed,
  ),
  t.Object(
    {
      state: t.Literal('unavailable'),
      reason: t.Literal('last_explicit_holder'),
    },
    closed,
  ),
]);
export const realmViewerActionsSchema = t.Object(
  {
    state: t.Literal('current'),
    enter: realmViewerActionSchema,
    manage: realmViewerActionSchema,
    leave: realmViewerActionSchema,
  },
  closed,
);

export const ownRealmsResponseSchema = t.Object(
  {
    items: t.Array(
      t.Object(
        {
          realmId: id,
          name: t.String({ minLength: 1, maxLength: 1024 }),
          role: t.Literal('member'),
          current: t.Object(
            {
              description: t.String({ maxLength: 4096 }),
              avatar: t.Union([
                t.Object(
                  {
                    state: t.Literal('available'),
                    value: RealmPresentationImageSchema,
                  },
                  closed,
                ),
                t.Object(
                  {
                    state: t.Union([t.Literal('none'), t.Literal('unavailable')]),
                    value: t.Null(),
                  },
                  closed,
                ),
              ]),
              banner: t.Union([
                t.Object(
                  {
                    state: t.Literal('available'),
                    value: RealmPresentationImageSchema,
                  },
                  closed,
                ),
                t.Object(
                  {
                    state: t.Union([t.Literal('none'), t.Literal('unavailable')]),
                    value: t.Null(),
                  },
                  closed,
                ),
              ]),
              destination: t.Object({ kind: t.Literal('realm'), realmId: id }, closed),
              spaceId: id,
              viewer: t.Object(
                {
                  readability: t.Literal('allowed'),
                  membership: t.Object(
                    {
                      state: t.Literal('member'),
                      since: t.String({ format: 'date-time' }),
                      reservationId: id,
                      transactionId: id,
                    },
                    closed,
                  ),
                  participation: t.Union([t.Literal('allowed'), t.Literal('denied')]),
                },
                closed,
              ),
              actions: realmViewerActionsSchema,
            },
            closed,
          ),
        },
        closed,
      ),
      { maxItems: 20 },
    ),
    next: t.Union([t.String(), t.Null()]),
  },
  closed,
);

export const SpaceSchema = t.Object(
  {
    spaceId: id,
    realmId: t.Union([id, t.Null()], {
      readOnly: true,
      description:
        'The active Realm carried by this Space, if the viewer passes its ordinary realm:read check; otherwise null. Derived per viewer and outside the Space revision chain. The Space ETag remains its head revision id, the If-Match token for Space writes.',
    }),
    state: t.Literal('active'),
    headRevisionId: id,
    createdAt: instant,
    creator: id,
    predecessor: t.Union([id, t.Null()]),
    address: t.Union([t.String(), t.Null()]),
    title,
    summary,
    revisionCreatedAt: instant,
    author: id,
  },
  closed,
);

const voteWeight = t.Unsafe<1 | -1>(t.Integer({ enum: [1, -1] }));
export const RealmVotesSchema = t.Object(
  {
    upvote: t.Optional(voteWeight),
    downvote: t.Optional(voteWeight),
    like: t.Optional(voteWeight),
    love: t.Optional(voteWeight),
    laugh: t.Optional(voteWeight),
    insightful: t.Optional(voteWeight),
    sad: t.Optional(voteWeight),
  } satisfies Record<(typeof REACTION_KINDS)[number], unknown>,
  closed,
);

export const RealmSchema = t.Object(
  {
    realmId: id,
    spaceId: id,
    state: t.Literal('active'),
    visibility: t.Union([t.Literal('public'), t.Literal('protected')]),
    contextId: id,
    boardSchemeId: t.Union([id, t.Null()]),
    ownershipState: t.Union([t.Literal('owned'), t.Literal('orphaned')]),
    orphanedAt: t.Union([instant, t.Null()]),
    claimEligibleAt: t.Union([instant, t.Null()]),
    governanceReadOnly: t.Boolean(),
    headRevisionId: id,
    createdAt: instant,
    creator: id,
    predecessor: t.Union([id, t.Null()]),
    title,
    summary,
    revisionCreatedAt: instant,
    author: id,
    votes: RealmVotesSchema,
    presentation: RealmPresentationSchema,
  },
  closed,
);
