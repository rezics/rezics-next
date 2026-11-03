import type { PoolClient } from 'pg';
import type { ShelfScoreQuestion } from '../library/shelf-contract.ts';
/** Shared native meaning for shelf ordering and the independent viewer-facts consumer. */
export declare function readPersonalScoreQuestion(client: Pick<PoolClient, 'query'>): Promise<ShelfScoreQuestion>;
/** Content supplies this only after holding all native Entry/vote identity effects for this owner.
 * A current result covers the entire matching owner shelf, including rows beyond this page,
 * in the caller's RR snapshot. The version changes before a merge/lifecycle can make that
 * ordering stale. This is independent of the bounded viewer-facts overlay.
 */
export type PersonalScoreCurrentness = (client: Pick<PoolClient, 'query'>, owner: {
    route: number;
    accountId: string;
    question: ShelfScoreQuestion;
}) => Promise<{
    status: 'current';
    version: string;
} | {
    status: 'pending' | 'unavailable';
    reason: string;
}>;
export declare const unavailablePersonalScoreCurrentness: PersonalScoreCurrentness;
