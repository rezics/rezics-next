import { type FieldErrorCode } from '../http/problem-error.ts';
import type { AdmittedSearchRequest, SearchRequest } from './service-contract.ts';
export declare function invalid(pointer: string, code: FieldErrorCode): never;
export declare function unsupported(pointer: string, code?: FieldErrorCode): never;
/** The public slice accepts one positive predicate over exact released bibliographic Types. */
export declare function hasPublicBookSearchShape(request: {
    filter?: unknown;
    sort?: unknown;
}): boolean;
/** Only the closed descriptor emitted by an installed, name-ordered Book TypeList. */
export declare function bookTypeListRequest(body: object, cursor?: string): SearchRequest | undefined;
export declare function containsRealmPredicate(value: unknown): boolean;
/** Parse and admit the caller's Search JSON once, before it reaches execution or cursor planning. */
export declare function admitSearchRequest(request: SearchRequest): AdmittedSearchRequest;
/** Classify the same bounded parser trees used by execution; never infer syntax from raw text. */
export declare function requiresAdvancedSearch(request: SearchRequest): boolean;
export type SearchRequestPlanner = Readonly<{
    admit: typeof admitSearchRequest;
    requiresAdvanced: typeof requiresAdvancedSearch;
}>;
export declare function createSearchRequestPlanner(): SearchRequestPlanner;
