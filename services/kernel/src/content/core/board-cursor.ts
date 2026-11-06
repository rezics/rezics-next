import {
  CONTENT_BOARD_SORTS,
  CONTENT_RANK_SORTS,
  CONTENT_UTC_TIMESTAMP_PATTERN,
  CONTENT_UUID_PATTERN,
  type ContentBoardCursorKey,
  type ContentBoardRankCursorKey,
  type ContentBoardSort,
  type ContentCursorAdmission,
  type ContentRankCursorAdmission,
  type ContentRankSort,
} from '../contract/index.ts';

/** Board listing queries strip surrounding whitespace and preserve remaining authored text. */
export function normalizeBoardQuery(query: string): string {
  if (typeof query !== 'string') throw new TypeError('Board query must be a string');
  return query.trim();
}

export function isUtcTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = CONTENT_UTC_TIMESTAMP_PATTERN.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return false;
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  return date.toISOString().slice(0, 19) === value.slice(0, 19);
}

export function isBoardCursorKey(value: unknown): value is ContentBoardCursorKey {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const key = value as Record<string, unknown>;
  return isUtcTimestamp(key.createdAt) && typeof key.threadId === 'string' && CONTENT_UUID_PATTERN.test(key.threadId);
}

export function isBoardRankCursorKey(value: unknown): value is ContentBoardRankCursorKey {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const key = value as Record<string, unknown>;
  return (
    typeof key.rank === 'number' &&
    Number.isFinite(key.rank) &&
    key.rank >= 0 &&
    typeof key.threadId === 'string' &&
    CONTENT_UUID_PATTERN.test(key.threadId)
  );
}

export function isBoardSort(value: unknown): value is ContentBoardSort {
  return typeof value === 'string' && (CONTENT_BOARD_SORTS as readonly string[]).includes(value);
}

export function isRankSort(value: unknown): value is ContentRankSort {
  return typeof value === 'string' && (CONTENT_RANK_SORTS as readonly string[]).includes(value);
}

export function admitBoardCursor(input: ContentCursorAdmission): 'newest' | 'oldest' | null {
  if (!Number.isSafeInteger(input.expectedEpoch) || input.expectedEpoch < 1) return null;
  if (input.sort !== 'newest' && input.sort !== 'oldest') return null;
  return input.sort;
}

export function admitBoardRankCursor(input: ContentRankCursorAdmission): ContentRankSort | null {
  if (!Number.isSafeInteger(input.expectedEpoch) || input.expectedEpoch < 1) return null;
  if (!isRankSort(input.sort)) return null;
  return input.sort;
}

export function isBoardPinRevision(value: unknown): value is string {
  return typeof value === 'string' && /^(0|[1-9][0-9]{0,18})$/.test(value);
}
