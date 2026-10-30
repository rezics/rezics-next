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
