import type { Kernel } from '@rezics/client';
import { kernelClient } from '../../kernel/client.ts';
import { sitemapLocales, type SitemapFeed } from '../feeds.ts';
import { sitemapFamilyFromPagePaths } from '../url.ts';

type SpacePage = Kernel['~Routes']['v1']['sitemap']['spaces']['get']['response'][200];
type SpaceItem = SpacePage['items'][number];

/** Community supplies the standalone-only native page, without filtering/hydrating it in Web. */
export type StandaloneSpaceProjection = (page: SpacePage) => SpacePage;

export function createSpaceFeed(standalone: StandaloneSpaceProjection = (page) => page): SitemapFeed<SpaceItem> {
  return {
    type: 'spaces',
    key: ({ id }) => `${id.slice(24, 28)}${id}`,
    async read(cursor) {
      const result = await kernelClient().sitemap.spaces.get({
        query: { ...(cursor === null ? {} : { cursor }), limit: 1_000 },
      });
      if (result.status !== 200 || !result.data)
        throw Object.assign(new Error(`Sitemap feed spaces returned ${result.status}`), { status: result.status });
      const page = standalone(result.data);
      if (page !== result.data) throw new Error('Space canonical projection must retain the native standalone page');
      return result.data;
    },
    family(item) {
      const path = `/spaces/${encodeURIComponent(item.address)}`;
      // The current revision clock is not a public publication clock for all shown dependencies.
      return sitemapFamilyFromPagePaths(
        Object.fromEntries(sitemapLocales.map((locale) => [locale, path])) as Record<
          (typeof sitemapLocales)[number],
          string
        >,
      );
    },
  };
}

export const feed = createSpaceFeed();
