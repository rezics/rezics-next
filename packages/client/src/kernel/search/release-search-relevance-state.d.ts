import type { Pool } from 'pg';
import type { ReleaseGroupingRequest } from './release-search-grouping.ts';
import type { ReleaseSearchCandidateCut } from './release-search-native-stream.ts';
export type ReleaseSearchRelevanceBinding = Readonly<{
    principal: string;
    request: ReleaseGroupingRequest;
    generation: number;
    cut: ReleaseSearchCandidateCut;
}>;
export type ReleaseSearchRelevanceLocation = Readonly<{
    execution: string;
    node: string;
}>;
export interface ReleaseSearchRelevanceState {
    /** Creates a new retained lineage with one empty immutable membership root. */
    start(binding: ReleaseSearchRelevanceBinding, now: number): Promise<ReleaseSearchRelevanceLocation>;
    /** Renews a valid cursor's private state before reading it. */
    resume(binding: ReleaseSearchRelevanceBinding, location: ReleaseSearchRelevanceLocation, now: number): Promise<void>;
    /** Looks up only this native page's candidate works in the cursor's immutable membership root. */
    seen(binding: ReleaseSearchRelevanceBinding, location: ReleaseSearchRelevanceLocation, works: readonly string[], now: number): Promise<ReadonlySet<string>>;
    /** Adds the emitted works as one replay-idempotent child of this cursor node. */
    advance(binding: ReleaseSearchRelevanceBinding, location: ReleaseSearchRelevanceLocation, branch: string, works: readonly string[], now: number): Promise<ReleaseSearchRelevanceLocation>;
}
export declare class ReleaseSearchRelevanceStateExpired extends Error {
    constructor();
}
export declare class ReleaseSearchRelevanceStateConflict extends Error {
    constructor();
}
type Run = <T>(operation: () => Promise<T>) => Promise<T>;
type Reserve = (pool: string) => void;
/** PostgreSQL-backed exact duplicate suppression with immutable fixed-depth membership roots. */
export declare function createReleaseSearchRelevanceState(input: {
    pool: Pool;
    deadline: number;
    run: Run;
    reserve: Reserve;
    poolId: string;
}): ReleaseSearchRelevanceState;
export {};
