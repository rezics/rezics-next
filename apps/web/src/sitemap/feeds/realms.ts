import type { Kernel } from '@rezics/client';
import { kernelClient } from '../../kernel/client.ts';
import { sitemapLocales, type SitemapFeed } from '../feeds.ts';
import { canonicalProjectionUnavailable } from '../canonical.ts';
import { sitemapFamilyFromPagePaths } from '../url.ts';

type RealmPage = Kernel['~Routes']['v1']['sitemap']['realms']['get']['response'][200];
type RealmItem = RealmPage['items'][number];

// Agreed Community destination union; the generated native feed does not expose it yet.
export type RealmCanonicalDestination =
  | { kind: 'space'; spaceId: string; address: string }
  | { kind: 'realm'; realmId: string };
export type RealmCanonicalProjection = (item: RealmItem) => RealmCanonicalDestination;

function unavailable(): never {
  return canonicalProjectionUnavailable('realms', 'Community canonicalDestination for carried and standalone Realms');
}

export function createRealmFeed(destination: RealmCanonicalProjection = unavailable): SitemapFeed<RealmItem> {
  return {
    type: 'realms',
    key: ({ id }) => `${id.slice(24, 28)}${id}`,
    async read(cursor) {
      const result = await kernelClient().sitemap.realms.get({
        query: { ...(cursor === null ? {} : { cursor }), limit: 1_000 },
      });
      if (result.status !== 200 || !result.data)
        throw Object.assign(new Error(`Sitemap feed realms returned ${result.status}`), { status: result.status });
      // An empty page does not establish that the missing canonical inventory contract is ready.
      if (destination === unavailable) unavailable();
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
