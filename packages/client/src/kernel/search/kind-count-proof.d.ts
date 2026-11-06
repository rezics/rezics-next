import type { DiscoveryKindMetadata, KindCountEvidence } from './discovery-api.ts';
import type { DiscoveryRegistry } from './discovery.ts';
/**
 * One whole-predicate kind-count decision. Hit-page rows and engine samples are witnesses,
 * never a total. Exact absence or membership needs current aggregate proof of the executed
 * disjunctive population.
 *
 * Cost
 * - Touches: the current disclosed identities already selected by one executed predicate,
 *   plus the caller's exhaustion and final-observation bits. No engine, Source or census read.
 * - Bound: one pass over the visible kind directory (at most eight rows) and the witness map
 *   for those kinds. Work is independent of corpus size.
 * - Growth check: `test/search/kind-count-proof.test.ts` covers continuation, incomplete
 *   samples, exact exhausted populations and refused exact-zero inference.
 */
export type KindCountProof = Readonly<{
    /** Opaque hit continuation, including an empty first page that still carries a cursor. */
    continuation: boolean;
    /** True only when the executed predicate examined every remaining candidate. */
    exhausted: boolean;
    /** True only after a clean START/FINAL of that same whole-predicate execution. */
    aggregateProof: boolean;
    /** Distinct current canonical identities per kind from that execution. */
    witnesses: ReadonlyMap<string, number>;
}>;
/** Catalogue kind chips never publish totals. Continuations stay unavailable; a sample is only a lower bound. */
export declare function publicCatalogueKindCounts(types: Iterable<string>, options: Readonly<{
    continuation: boolean;
    exhausted: boolean;
}>): Map<string, number>;
export declare function proveKindCount(kind: string, proof: KindCountProof): KindCountEvidence;
export declare function projectKindDirectoryCounts<Entry extends {
    kind: string;
    metadata: DiscoveryKindMetadata;
}>(registry: DiscoveryRegistry, entries: readonly Entry[], proof: KindCountProof): Array<DiscoveryKindMetadata & {
    count: KindCountEvidence;
}>;
