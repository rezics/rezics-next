import { type ContentBoardCursorKey, type ContentBoardRankCursorKey, type ContentBoardSort, type ContentCursorAdmission, type ContentRankCursorAdmission, type ContentRankSort } from '../contract/index.ts';
/** Board listing queries strip surrounding whitespace and preserve remaining authored text. */
export declare function normalizeBoardQuery(query: string): string;
export declare function isUtcTimestamp(value: unknown): value is string;
export declare function isBoardCursorKey(value: unknown): value is ContentBoardCursorKey;
export declare function isBoardRankCursorKey(value: unknown): value is ContentBoardRankCursorKey;
export declare function isBoardSort(value: unknown): value is ContentBoardSort;
export declare function isRankSort(value: unknown): value is ContentRankSort;
export declare function admitBoardCursor(input: ContentCursorAdmission): 'newest' | 'oldest' | null;
export declare function admitBoardRankCursor(input: ContentRankCursorAdmission): ContentRankSort | null;
export declare function isBoardPinRevision(value: unknown): value is string;
