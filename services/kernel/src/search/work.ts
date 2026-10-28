import { ConfigError } from '../commerce/config.ts';
import { subjectListingSource } from '../library/listing-counts.ts';
import { subjectSource } from '../semantic/search-source.ts';
import { readMembershipRouteKey } from '../access/membership-work-config.ts';
import type { WorkModule } from '../work/registry.ts';
import { createOpenSearch } from './opensearch.ts';
import { startSearchIndexing } from './runner.ts';

export type SearchConfig = { url: string; prefix: string };

const PREFIX = /^[a-z0-9][a-z0-9-]{0,47}$/;

/** `undefined` when search is not configured. The URL and prefix are refused by name. */
export function readSearchConfig(env: { readonly [name: string]: string | undefined }): SearchConfig | undefined {
  const url = env.OPENSEARCH_URL;
  if (!url) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ConfigError('OPENSEARCH_URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new ConfigError('OPENSEARCH_URL');
  const prefix = env.KERNEL_SEARCH_PREFIX ?? 'rezics-';
  if (!PREFIX.test(prefix)) throw new ConfigError('KERNEL_SEARCH_PREFIX');
  return { url, prefix };
}

export const searchWorkModule: WorkModule = {
  name: 'search',
  register(context) {
    const config = readSearchConfig(context.env);
    if (!config) return;
    const routeKey = readMembershipRouteKey(context.env);
    context.addService(() =>
      startSearchIndexing({
        pool: context.pool,
        search: createOpenSearch(config.url),
        source: subjectSource(context.pool, routeKey),
        listing: subjectListingSource(context.pool),
        prefix: config.prefix,
        concurrency: 2,
      }),
    );
  },
};
