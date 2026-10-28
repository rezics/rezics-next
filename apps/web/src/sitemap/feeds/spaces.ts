import { kernelClient } from '../../kernel/client.ts';
import { sitemapLocales, type SitemapFeed } from '../feeds.ts';

type SpaceItem = { id: string; address: string; lastModified?: string };

function family(item: SpaceItem) {
  const path = `/spaces/${encodeURIComponent(item.address)}`;
  return {
    paths: Object.fromEntries(sitemapLocales.map((locale) => [locale, `/${locale}${path}`])) as Record<
      (typeof sitemapLocales)[number],
      string
    >,
    ...(typeof item.lastModified === 'string' ? { lastmod: item.lastModified } : {}),
  };
}

export const feed: SitemapFeed<SpaceItem> = {
  type: 'spaces',
  key: ({ id }) => `${id.slice(24, 28)}${id}`,
  async read(cursor) {
    const result = await kernelClient().sitemap.spaces.get({
      query: { ...(cursor === null ? {} : { cursor }), limit: 1_000 },
    });
    if (result.status !== 200 || !result.data)
      throw Object.assign(new Error(`Sitemap feed spaces returned ${result.status}`), { status: result.status });
    return result.data;
  },
  family,
};
