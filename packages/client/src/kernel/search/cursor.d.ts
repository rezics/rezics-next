import type { KeyRing } from '../tokens/seal.ts';
import type { PublicFilterConsumerJob, PublicFilterQueriedObservation } from './public-filter-consumer-contract.ts';
import type { SearchConsumedWindow, SearchFrontier, SearchWindowWork } from './useful-page.ts';
import type { RatingCursorContext } from './rating-cursor.ts';
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
}, now?: number): Promise<string>;
export declare function decodeSearchCursor(ring: KeyRing, binding: SearchCursorBinding, token: string, now?: number): Promise<SearchCursorResult>;
/** Confidential locator only. The producer revalidates it against its native retained state. */
export type RetainedSearchContinuation = Readonly<{
    queried: PublicFilterQueriedObservation;
    repair: PublicFilterConsumerJob;
    window: SearchConsumedWindow;
    work: SearchWindowWork;
    frontier: SearchFrontier;
    rating?: RatingCursorContext;
}>;
export declare function encodeRetainedSearchCursor(ring: KeyRing, binding: SearchCursorBinding, generation: number, continuation: RetainedSearchContinuation, now?: number): Promise<string>;
export declare function retainedSearchContinuation(after: readonly SearchSortValue[]): RetainedSearchContinuation | null;
/** A real retained observation locator, not a digest over mutable index state or an authority token. */
export type DiscoveryCursorState = {
    release: string;
    registry: string;
    queried: PublicFilterQueriedObservation;
    after: SearchSortValue[];
    retained?: {
        execution: string;
        consumed: number;
    };
    repair?: PublicFilterConsumerJob;
};
export declare function encodeDiscoveryCursor(ring: KeyRing, binding: SearchCursorBinding, state: DiscoveryCursorState, now?: number): Promise<string>;
export declare function decodeDiscoveryCursor(ring: KeyRing, binding: SearchCursorBinding, token: string, now?: number): Promise<{
    ok: true;
    state: DiscoveryCursorState;
} | {
    ok: false;
    reason: 'expired' | 'invalid';
}>;
