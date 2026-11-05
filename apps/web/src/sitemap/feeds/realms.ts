import type { Kernel } from '@rezics/client';
import { kernelClient } from '../../kernel/client.ts';
import { sitemapLocales, type SitemapFeed } from '../feeds.ts';
import { sitemapFamilyFromPagePaths } from '../url.ts';

type RealmPage = Kernel['~Routes']['v1']['sitemap']['realms']['get']['response'][200];
type RealmItem = RealmPage['items'][number];

export type RealmCanonicalDestination = RealmItem['canonicalDestination'];
export type RealmCanonicalProjection = (item: RealmItem) => RealmCanonicalDestination;

export function createRealmFeed(
  destination: RealmCanonicalProjection = (item) => item.canonicalDestination,
): SitemapFeed<RealmItem> {
  return {
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
    family(item) {
      const target = destination(item);
      const path =
        target.kind === 'space'
          ? `/spaces/${encodeURIComponent(target.address)}`
          : `/realms/${encodeURIComponent(target.realmId)}`;
      // Current head/newest-board time does not establish all meaningful shown changes of a carried page.
      return sitemapFamilyFromPagePaths(
        Object.fromEntries(sitemapLocales.map((locale) => [locale, path])) as Record<
          (typeof sitemapLocales)[number],
          string
        >,
      );
    },
  };
}

export const feed = createRealmFeed();
