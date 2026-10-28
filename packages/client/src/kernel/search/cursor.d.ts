import type { KeyRing } from '../tokens/seal.ts';
export type SearchCursorBinding = {
    operation: string;
    request: unknown;
    principal: string;
};
export type SearchSortValue = string | number | null;
export type SearchCursorResult = {
    ok: true;
    generation: number;
    after: SearchSortValue[];
} | {
    ok: false;
    reason: 'expired' | 'invalid';
};
export declare function encodeSearchCursor(ring: KeyRing, binding: SearchCursorBinding, cursor: {
    generation: number;
    after: readonly SearchSortValue[];
}, now?: number): string;
export declare function decodeSearchCursor(ring: KeyRing, binding: SearchCursorBinding, token: string, now?: number): SearchCursorResult;
