import type { SitemapFamily } from './pack.ts';

export type SitemapFeed<Item> = {
  type: string;
  read(cursor: string | null): Promise<{ items: Item[]; next: string | null }>;
  family(item: Item): SitemapFamily | null;
};

type FeedModule = { feed?: SitemapFeed<unknown> };

/** Loads one feed per module; the pages and their 1,000-item limit belong to the feed implementation. */
export function sitemapFeeds(): SitemapFeed<unknown>[] {
  if (typeof import.meta.glob !== 'function') return [];
  const modules = import.meta.glob('./feeds/*.ts', { eager: true }) as Record<string, FeedModule>;
  return Object.entries(modules)
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([, module]) => (module.feed ? [module.feed] : []));
}
