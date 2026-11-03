import type { SearchSortValue } from './cursor.ts';
import type { HitResult, SearchHit } from './query.ts';
import type { RatingPhase } from './rating-cursor.ts';
import type { PublicFilterConsumerRefill, PublicFilterConsumerWindow } from './public-filter-consumer-contract.ts';
export type SearchFrontier = Readonly<{
    after?: readonly SearchSortValue[];
    ratingPhase?: RatingPhase;
}>;
export type UsefulPage<T> = Readonly<{
    status: 'filled' | 'exhausted' | 'preparing';
    values: readonly T[];
    frontier: SearchFrontier;
    candidates: number;
    rounds: number;
}>;
/** Native iteration only: read must reject incomplete shards, timeouts and lost observations.
 * In particular it must return raw hits, before disclosure/canonical filtering or slicing.
 * The caller owns the immutable observation and all native operation/point/byte accounting.
 */
export declare function collectUsefulPage<T>(options: {
    limit: number;
    frontier?: SearchFrontier;
    prepared?: boolean;
    read: (request: SearchFrontier & {
        size: number;
    }) => Promise<HitResult>;
    check: (hits: readonly SearchHit[]) => Promise<ReadonlyMap<SearchHit, T>>;
    canonicalId: (value: T) => string;
}): Promise<UsefulPage<T>>;
export type SearchConsumedWindow = Readonly<{
    execution: string;
    consumed: number;
}>;
export type SearchWindowWork = Readonly<{
    candidates: number;
    rounds: number;
}>;
export type RetainedUsefulPage<T> = Omit<UsefulPage<T>, 'frontier'> & Readonly<{
    frontier: SearchFrontier;
    continuation: SearchConsumedWindow;
}>;
/** The producer owns the retained raw keys, canonical population and all native budgets.
 * A filtered hit vector, including an empty vector, says nothing about exhaustion.
 * Each refill spends the same root allowance; no raw engine key is sent back to query.
 */
export declare function collectRetainedUsefulPage<T>(options: {
    limit: number;
    prepared?: boolean;
    continuation?: SearchConsumedWindow;
    spent?: SearchWindowWork;
    frontier?: SearchFrontier;
    read: (size: number, refill?: PublicFilterConsumerRefill) => Promise<Readonly<{
        execution: string;
        hits: readonly SearchHit[];
        window: PublicFilterConsumerWindow;
    }>>;
    check: (hits: readonly SearchHit[]) => Promise<ReadonlyMap<SearchHit, T>>;
    canonicalId: (value: T) => string;
    /** Persist the actual prefix, including rejects and duplicates, before any refill. */
    consume?: (continuation: SearchConsumedWindow) => Promise<void>;
}): Promise<RetainedUsefulPage<T>>;
