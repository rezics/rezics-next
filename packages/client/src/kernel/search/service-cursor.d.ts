import type { KeyRing } from '../tokens/seal.ts';
import { type SearchCursorBinding } from './cursor.ts';
import type { ScopeBasis } from './scope-source.ts';
import type { AdmittedSearchRequest, ExecutedSearchRequest } from './service-contract.ts';
/** Bind the Scope's immutable source basis to the already admitted request identity. */
export declare function bindSearchScopeCursorRequest(request: unknown, basis: ScopeBasis): unknown;
export declare function scopeCursorAfter(sort: 'id', after: readonly (string | number | null)[]): string;
export declare function scopeCursorAfter(sort: 'name', after: readonly (string | number | null)[]): readonly [string | null, string];
export declare function scopeCursorAfter(sort: 'collections', after: readonly (string | number | null)[]): readonly [number, string | null, string];
export declare function encodeKindCursor(ring: KeyRing, binding: SearchCursorBinding, generation: number, digest: string, after: string, now: number): Promise<string>;
export declare function decodeKindCursor(ring: KeyRing, binding: SearchCursorBinding, token: string, generation: number, digest: string, now: number): Promise<string>;
export type SearchCursorPlanner = Readonly<{
    bindExecutionRequest: (admission: AdmittedSearchRequest, identityEpoch: string) => ExecutedSearchRequest;
    bindScopeRequest: (request: ExecutedSearchRequest, basis: ScopeBasis) => unknown;
    scopeAfter: typeof scopeCursorAfter;
    encodeKind: typeof encodeKindCursor;
    decodeKind: typeof decodeKindCursor;
}>;
/** Build one post-admission request object and use it for every cursor binding in the execution. */
export declare function createSearchCursorPlanner(): SearchCursorPlanner;
