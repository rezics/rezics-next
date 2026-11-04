import { TEXT_LIMITS } from '../../../../packages/search-text/src/index.ts';

export const GLOBAL_SEARCH_QUERY_BYTE_LIMIT = TEXT_LIMITS.bytes;

const encoder = new TextEncoder();

export function isWithinGlobalSearchQueryLimit(query: string): boolean {
  return encoder.encode(query).byteLength <= GLOBAL_SEARCH_QUERY_BYTE_LIMIT;
}
