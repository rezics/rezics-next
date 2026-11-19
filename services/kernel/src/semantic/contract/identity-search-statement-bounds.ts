export const SEARCH_INDEX_SMALL_WINDOW = 4;
export const SEARCH_INDEX_STATEMENT_KEYS = 8;
export const SEARCH_INDEX_STATEMENT_BYTES = 65536;
export const SEARCH_INDEX_PROVENANCE_BYTES = 4096;

// Wider selections share one body allowance. Keep the full per-statement bound for the original small window.
export function canonicalStatementBodyBytes(keys: number) {
  return keys <= SEARCH_INDEX_SMALL_WINDOW
    ? SEARCH_INDEX_STATEMENT_BYTES
    : Math.floor(SEARCH_INDEX_STATEMENT_BYTES / keys);
}
