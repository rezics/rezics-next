import { type CursorBinding } from '../tokens/cursor.ts';
import type { KeyRing } from '../tokens/seal.ts';
export type AuthorItemCursorKey = Readonly<{
    createdAt: string;
    itemId: string;
}>;
export declare function encodeAuthorItemKey(ring: KeyRing, scope: CursorBinding, key: AuthorItemCursorKey, epoch: number, now: number): string;
export declare function decodeAuthorItemKey(ring: KeyRing, scope: CursorBinding, token: string, epoch: number, now: number): AuthorItemCursorKey;
