import { VNDB_ID, VNDB_ROWS } from './contract';

export type VndbReviewAddress = { uploadId: string; offset: number };

/** URL input identifies retained evidence, never a source record or permission to read it. */
export function vndbReviewSearch(search: Record<string, unknown>): {
  uploadId?: string;
  offset?: number;
} {
  if (search.uploadId === undefined && search.offset === undefined) return {};
  const offset = search.offset === undefined ? 0 : Number(search.offset);
  if (
    typeof search.uploadId !== 'string' ||
    !VNDB_ID.test(search.uploadId) ||
    (search.offset !== undefined && typeof search.offset !== 'number' && typeof search.offset !== 'string') ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset >= VNDB_ROWS
  )
    throw new Error('Invalid VNDB review address');
  return { uploadId: search.uploadId, offset };
}

export function vndbReviewHref(address: VndbReviewAddress): string {
  return `/library/import-vndb?${new URLSearchParams({ uploadId: address.uploadId, offset: String(address.offset) })}`;
}
