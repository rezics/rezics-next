import { kernelClient } from '../../kernel/client.ts';
import { sitemapLocales, type SitemapFeed } from '../feeds.ts';

type RealmItem = { id: string; lastModified?: string };

function family(item: RealmItem) {
  const path = `/realms/${encodeURIComponent(item.id)}`;
  return {
    paths: Object.fromEntries(sitemapLocales.map((locale) => [locale, `/${locale}${path}`])) as Record<
      (typeof sitemapLocales)[number],
      string
    >,
    ...(typeof item.lastModified === 'string' ? { lastmod: item.lastModified } : {}),
  };
}

export const feed: SitemapFeed<RealmItem> = {
  type: 'realms',
  key: ({ id }) => `${id.slice(24, 28)}${id}`,
  async read(cursor) {
    const result = await kernelClient().sitemap.realms.get({
      query: { ...(cursor === null ? {} : { cursor }), limit: 1_000 },
    });
    if (result.status !== 200 || !result.data)
      throw Object.assign(new Error(`Sitemap feed realms returned ${result.status}`), { status: result.status });
    return result.data;
  },
  family,
};
