import type { SitemapFamily } from './pack.ts';
import { locales } from '../paraglide/runtime.js';
import { feed as agents } from './feeds/agents.ts';
import { feed as boards } from './feeds/boards.ts';
import { feed as collections } from './feeds/collections.ts';
import { feed as realms } from './feeds/realms.ts';
import { feed as spaces } from './feeds/spaces.ts';
import { feed as subjects } from './feeds/subjects.ts';
import { feed as threads } from './feeds/threads.ts';

export const sitemapLocales = locales;

export type SitemapFeed<Item> = {
  type: string;
  read(cursor: string | null): Promise<{ items: Item[]; next: string | null }>;
  family(item: Item): SitemapFamily | null;
  key?(item: Item): string;
};

type FeedModule = { feed?: SitemapFeed<unknown> };

/** Loads one feed per module; the pages and their 1,000-item limit belong to the feed implementation. */
export function sitemapFeeds(): SitemapFeed<unknown>[] {
  if (typeof import.meta.glob !== 'function') return [agents, boards, collections, realms, spaces, subjects, threads];
  const modules = import.meta.glob('./feeds/*.ts', { eager: true }) as Record<string, FeedModule>;
  return Object.entries(modules)
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([, module]) => (module.feed ? [module.feed] : []));
}
