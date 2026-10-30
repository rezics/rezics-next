import { t } from 'elysia';
import { ContentIdSchema, sitemapPageSchema } from '../content/schemas.ts';

const closed = { additionalProperties: false } as const;
const id = t.String({ format: 'uuid' });

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
  { id: ContentIdSchema, address: t.String(), lastModified: t.String({ format: 'date-time' }) },
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
          avatar: t.Null(),
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

export const ownRealmsResponseSchema = t.Object(
  {
    items: t.Array(
      t.Object(
        {
          realmId: id,
          name: t.String({ minLength: 1, maxLength: 1024 }),
          role: t.Literal('member'),
        },
        closed,
      ),
    ),
    next: t.Union([t.String(), t.Null()]),
  },
  closed,
);
