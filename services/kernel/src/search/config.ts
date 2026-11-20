import { ConfigError } from '../commerce/config.ts';
import { isAdmittedSearchPrefix } from './consumer-name.ts';

export type SearchConfig = { url: string; prefix: string; subjectAckProtocol?: 1; subjectSubscriptionProtocol?: 1 };

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
  function enabled(name: string) {
    const value = env[name];
    if (value !== undefined && value !== '0' && value !== '1') throw new ConfigError(name);
    return value === '1';
  }
  return {
    url,
    prefix,
    ...(enabled('KERNEL_SEARCH_SUBJECT_ACK_PROTOCOL') ? { subjectAckProtocol: 1 } : {}),
    ...(enabled('KERNEL_SEARCH_SUBJECT_SUBSCRIPTION_PROTOCOL') ? { subjectSubscriptionProtocol: 1 } : {}),
  };
}
