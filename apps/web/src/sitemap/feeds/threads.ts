import { kernelClient } from '../../kernel/client.ts';
import { threadHref } from '../../threads/thread-href.ts';
import { sitemapLocales, type SitemapFeed } from '../feeds.ts';

type ThreadItem = { id: string; title: string | null; lastModified?: string };

function family(item: ThreadItem) {
  const path = threadHref({ id: item.id, title: item.title });
  return {
    paths: Object.fromEntries(sitemapLocales.map((locale) => [locale, `/${locale}${path}`])) as Record<
      (typeof sitemapLocales)[number],
      string
    >,
    ...(typeof item.lastModified === 'string' ? { lastmod: item.lastModified } : {}),
  };
}

export const feed: SitemapFeed<ThreadItem> = {
  type: 'threads',
  async read(cursor) {
    const result = await kernelClient().sitemap.threads.get({
      query: { ...(cursor === null ? {} : { cursor }), limit: 1_000 },
    });
    if (result.status !== 200 || !result.data)
      throw Object.assign(new Error(`Sitemap feed threads returned ${result.status}`), { status: result.status });
    return result.data;
  },
  family,
};
