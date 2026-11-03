import type { KeyRing } from '../tokens/seal.ts';
export type BoardCursorSort = 'newest' | 'oldest' | 'active' | 'hot';
export type BoardCursorViewer = {
    kind: 'account';
    accountId: string;
} | {
    kind: 'anonymous';
};
export type BoardCursorBinding = {
    boardId: string;
    query: string;
    sort: BoardCursorSort;
    /** Decimal board-home pin-set counter, read with the candidate range. */
    pinRevision: string;
    /** The caller supplies an authenticated account identity or an anonymous actor. */
    viewer: BoardCursorViewer;
};
export type BoardCursorKey = {
    createdAt: string;
    threadId: string;
};
export type BoardRankCursorKey = {
    rank: number;
    threadId: string;
};
export type BoardCursorResult = {
    ok: true;
    epoch: number;
    after: BoardCursorKey;
} | {
    ok: false;
    reason: 'expired' | 'invalid' | 'stale';
};
export type BoardRankCursorResult = {
    ok: true;
    epoch: number;
    after: BoardRankCursorKey;
} | {
    ok: false;
    reason: 'expired' | 'invalid' | 'stale';
};
/** Board listing queries strip surrounding whitespace and preserve all remaining authored text. */
export declare function normalizeBoardQuery(query: string): string;
/** Encode the last scanned row using the shared signed cursor format and lifetime. */
export declare function encodeBoardCursor(ring: KeyRing, binding: BoardCursorBinding, epoch: number, after: BoardCursorKey, now?: number): string;
/** Decode for the caller's current epoch; malformed tokens and bindings return a typed failure. */
export declare function decodeBoardCursor(ring: KeyRing, binding: BoardCursorBinding, token: string, expectedEpoch: number, now?: number): BoardCursorResult;
/** Encode a rank position using a cursor binding that includes active or hot sort. */
export declare function encodeBoardRankCursor(ring: KeyRing, binding: BoardCursorBinding, epoch: number, after: BoardRankCursorKey, now?: number): string;
/** Decode a rank position only for its bound sort, board, query, viewer and epoch. */
export declare function decodeBoardRankCursor(ring: KeyRing, binding: BoardCursorBinding, token: string, expectedEpoch: number, now?: number): BoardRankCursorResult;
