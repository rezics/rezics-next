export const GLOBAL_SEARCH_QUERY_BYTE_LIMIT = 512;

const encoder = new TextEncoder();

export function isWithinGlobalSearchQueryLimit(query: string): boolean {
  return encoder.encode(query).byteLength <= GLOBAL_SEARCH_QUERY_BYTE_LIMIT;
}
