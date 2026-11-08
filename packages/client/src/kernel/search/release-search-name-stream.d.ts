import type { SubjectCanonicalNameKey, SubjectCanonicalNames, SubjectCanonicalPopulation } from '../semantic/subject-source-key-pages.ts';
export type ReleaseSearchNamePool = Readonly<{
    id: string;
    names: SubjectCanonicalNames;
}>;
/** Native dispatch allowance, reserved before reads, including empty and replayed seeks.
 * Each home seek performs two population observations and one owner read inside the native reader.
 * This accounts for the name frontier only; matching, disclosure and card work need their own reservations.
 */
export type ReleaseSearchNameReservation = Readonly<{
    pool: string;
    observations: number;
    ownerReads: number;
    nameSeeks: number;
    keys: number;
}>;
type Context = Readonly<{
    deadline: number;
    reserve: (reservation: ReleaseSearchNameReservation) => void;
}>;
export type ReleaseSearchNameCut = Readonly<{
    epoch: string;
    pools: readonly Readonly<{
        id: string;
        population: SubjectCanonicalPopulation;
    }>[];
}>;
type Candidate = SubjectCanonicalNameKey & Readonly<{
    pool: string;
    partition: number;
    securityRevision: number;
}>;
/** Retain every pool, including those with no occupied home, so new population invalidates progress. */
export declare function observeReleaseSearchNames(pools: readonly ReleaseSearchNamePool[], context: Context): Promise<ReleaseSearchNameCut>;
/** Complete native candidate stream for both group discovery and per-work child discovery.
 * The caller classifies and matches these current keys using complete native evidence; a key alone grants
 * neither disclosure nor ownership. Private positions must pass through the existing encrypted cursors.
 * A common frontier lets each pool replay unconsumed lookahead without a growing per-pool cursor or seen set.
 */
export declare function readReleaseSearchNames(input: {
    pools: readonly ReleaseSearchNamePool[];
    cut: ReleaseSearchNameCut;
    after: string | null;
    size: number;
    context: Context;
}): Promise<{
    keys: Candidate[];
    after: string;
    exhausted: boolean;
}>;
export {};
