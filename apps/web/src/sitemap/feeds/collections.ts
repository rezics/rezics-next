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
    ...(typeof item.lastModified === 'string' ? { lastmod: item.lastModified } : {}),
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
