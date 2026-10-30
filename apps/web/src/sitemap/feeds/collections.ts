import { kernelClient } from '../../kernel/client.ts';
import { sitemapLocales, type SitemapFeed } from '../feeds.ts';

type CollectionItem = { id: string; lastModified?: string };
type CollectionSitemapClient = {
  sitemap: {
    collections: {
      get(options: {
        query: { cursor?: string; limit: number };
      }): Promise<{ status: number; data?: { items: CollectionItem[]; next: string | null } }>;
    };
  };
};

function family(item: CollectionItem) {
  const path = `/collections/${encodeURIComponent(item.id)}`;
  return {
    paths: Object.fromEntries(sitemapLocales.map((locale) => [locale, `/${locale}${path}`])) as Record<
      (typeof sitemapLocales)[number],
      string
    >,
    // The native feed currently returns header updatedAt, which does not cover public member changes.
    // Omit lastmod until the owner supplies meaningful public publication time.
  };
}

export const feed: SitemapFeed<CollectionItem> = {
  type: 'collections',
  key: ({ id }) => `${id.slice(24, 28)}${id}`,
  async read(cursor) {
    const client = kernelClient() as unknown as CollectionSitemapClient;
    const result = await client.sitemap.collections.get({
      query: { ...(cursor === null ? {} : { cursor }), limit: 1_000 },
    });
    if (result.status !== 200 || !result.data)
      throw Object.assign(new Error(`Sitemap feed collections returned ${result.status}`), { status: result.status });
    return result.data;
  },
  family,
};
