import { ConfigError } from '../commerce/config.ts';
import { isAdmittedSearchPrefix } from './consumer-name.ts';

export type SearchConfig = { url: string; prefix: string };

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
  if (!isAdmittedSearchPrefix(prefix)) throw new ConfigError('KERNEL_SEARCH_PREFIX');
  return { url, prefix };
}
