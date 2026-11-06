import type { Freshness } from './freshness.ts';
/** Deliberately contains no relay identity, lag count or event timestamp. */
export declare const SearchFreshnessSchema: import("typebox").TObject<{
    state: import("typebox").TUnion<[import("typebox").TLiteral<"current">, import("typebox").TLiteral<"catching-up">, import("typebox").TLiteral<"unavailable">]>;
}>;
export type SearchFreshness = {
    state: 'current' | 'catching-up' | 'unavailable';
};
export type SearchObservation = {
    as_of: string;
    freshness: SearchFreshness;
};
export declare function publicFreshness(observed: Freshness): SearchFreshness;
export declare function searchObservation(observed: Freshness): SearchObservation;
