import type { ZoneBrowseQuery } from '../realm/types.ts';
import { parseBrowseState, type BrowseState } from './browse-state.ts';

const sorts = ['newest', 'updated', 'relevance'] as const;

/** Site family recorded on a Zone presentation. The literal stays a prefix field, not a link. */
export const recordedSitePrefix = { prefix: '/z/' as const }.prefix;

/**
 * The recorded browse URL as the query the production reader sends.
 * Absent parameters stay absent: a refusal is recorded without limit or language.
 */
export function recordedBrowseRequest(path: string): { realm: string; query: ZoneBrowseQuery; state: BrowseState } {
  const url = new URL(path, 'https://recorded.invalid');
  const sortValue = url.searchParams.get('sort');
  const sort = sorts.find(item => item === sortValue);
  if (sortValue && !sort) throw new Error('Recorded browse sort is not admitted');
  const limit = url.searchParams.get('limit');
  const language = url.searchParams.get('language');
  const text = url.searchParams.get('q');
  const cursor = url.searchParams.get('cursor');
  const type = url.searchParams.getAll('type');
  const realm = url.pathname.split('/')[3];
  if (!realm) throw new Error('Recorded browse path has no realm');
  return {
    realm,
    query: {
      ...(sort ? { sort } : {}),
      ...(limit ? { limit: Number(limit) } : {}),
      ...(language ? { language } : {}),
      ...(text ? { q: text } : {}),
      ...(cursor ? { cursor } : {}),
      ...(type.length ? { type } : {}),
    },
    state: parseBrowseState({
      ...(sort ? { sort } : {}),
      ...(text ? { q: text } : {}),
      ...(cursor ? { cursor } : {}),
      type: type.map(item => item.replace('https://schema.org/', 'schema:')),
    }),
  };
}
