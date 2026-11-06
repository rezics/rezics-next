import type { PrivacyReductionHead } from '../semantic/index.ts';
import { type KindCountProof } from './kind-count-proof.ts';
import type { KindCountEvidence } from './discovery-api.ts';
/**
 * Whole-query currentness and independent proofs. Dropping a stale hit or seeing an ordinary
 * checkpoint never certifies membership, exclusion, order or aggregates. Source blocking is the
 * relevant pending/changed classification; unacknowledged or changed heads that are not blocking
 * are trusted stale observations and recover ordinary permitted pages.
 *
 * Cost
 * - Touches: the already observed privacy heads for one execution, plus independently supplied
 *   exhaustion, cursor and witness bits. No engine, Source or SQL.
 * - Bound: one pass over at most the bounded blocking summaries (one per home and phase) and the
 *   kind-witness map (at most eight kinds). Independent of corpus size.
 * - Growth check: `test/search/query-privacy.test.ts` covers trusted stale recovery, relevant
 *   blocking, distinct cursor/kind/aggregate proofs and refused sample totals.
 */
export type QueryPrivacyBarrierScope = 'filter_or_order' | 'returned_subject' | 'unresolved';
export type QueryPrivacyBarrierPhase = 'pending' | 'changed';
export type QueryPrivacyBarrier = Readonly<{
    head: PrivacyReductionHead;
    scope: QueryPrivacyBarrierScope;
    phase: QueryPrivacyBarrierPhase;
}>;
/** Shared fields of a Source or consumer observation used for disclosure. */
export type QueryPrivacyHeads = Readonly<{
    /** False means native routing cannot prove irrelevance; queries prepare. */
    routingComplete: boolean;
    unacknowledged: readonly PrivacyReductionHead[];
    changed: readonly PrivacyReductionHead[];
    blocking: readonly QueryPrivacyBarrier[];
}>;
export type QueryPrivacyDecision = Readonly<{
    status: 'current';
    stale: false;
}> | Readonly<{
    status: 'current';
    stale: true;
    unacknowledged: readonly PrivacyReductionHead[];
    changed: readonly PrivacyReductionHead[];
}> | Readonly<{
    status: 'preparing';
    reason: 'routing_incomplete' | 'blocking';
}>;
export type QueryPrivacyCursorProof = Readonly<{
    kind: 'admitted-cursor';
    observation: string;
    execution: string | undefined;
    consumed: number;
}>;
export type QueryPrivacyKindWitness = Readonly<{
    kind: 'kind-witness';
    evidence: KindCountEvidence;
}>;
export type QueryPrivacyAggregateProof = Readonly<{
    kind: 'exact-aggregate';
    evidence: KindCountEvidence;
}>;
export type QueryPrivacyProof = QueryPrivacyCursorProof | QueryPrivacyKindWitness | QueryPrivacyAggregateProof | Readonly<{
    kind: 'withheld';
}>;
/** Reject a malformed observation rather than treating missing routing as clean. */
export declare function admitQueryPrivacyHeads(value: unknown): QueryPrivacyHeads;
/**
 * Currentness for disclosure. Relevant pending/changed heads block. Irrelevant unacknowledged or
 * already-changed heads on this observation are trusted stale and remain current.
 */
export declare function queryPrivacyCurrentness(heads: QueryPrivacyHeads): QueryPrivacyDecision;
/** True when this observation may disclose hits, exclusion, order and current fields. */
export declare function observationIsDisclosable(heads: QueryPrivacyHeads): boolean;
/** Trusted stale: Source classified no relevant barrier, so the delayed index may still serve. */
export declare function trustedStaleObservation(decision: QueryPrivacyDecision): boolean;
export declare function queryPrivacyPreparing(decision: QueryPrivacyDecision): decision is Extract<QueryPrivacyDecision, {
    status: 'preparing';
}>;
export declare function admitQueryPrivacyCursor(input: {
    observation: string;
    execution?: string;
    consumed: number;
}): QueryPrivacyCursorProof;
/**
 * Replay uses the admitted locator only after currentness. A relevant reduction restarts;
 * trusted stale continues and re-discloses remaining hits. The cursor never certifies totals.
 */
export declare function replayQueryPrivacyCursor(admitted: QueryPrivacyCursorProof, currentness: QueryPrivacyDecision): 'continue' | 'restart' | 'preparing';
export declare function queryPrivacyKindWitness(kind: string, proof: KindCountProof): QueryPrivacyKindWitness;
export declare function queryPrivacyExactAggregate(kind: string, proof: KindCountProof): QueryPrivacyAggregateProof;
/** Sampled hits are witnesses. They never become an exact total, including an exact zero. */
export declare function sampledHitsCannotCertifyTotal(proof: KindCountProof): boolean;
export type QueryPrivacyProofSet = Readonly<{
    cursor: QueryPrivacyCursorProof | null;
    kinds: ReadonlyMap<string, QueryPrivacyKindWitness>;
    aggregates: ReadonlyMap<string, QueryPrivacyAggregateProof>;
}>;
/**
 * Build the three independent proofs for one executed predicate. A continuation keeps kind
 * witnesses and aggregates withheld. Exact aggregates require current whole-query proof.
 */
export declare function queryPrivacyProofs(input: {
    currentness: QueryPrivacyDecision;
    cursor?: {
        observation: string;
        execution?: string;
        consumed: number;
    };
    kinds: Iterable<string>;
    witnesses: ReadonlyMap<string, number>;
    continuation: boolean;
    exhausted: boolean;
    aggregateProof: boolean;
}): QueryPrivacyProofSet;
export declare function queryPrivacyProofKind(proof: QueryPrivacyProof): QueryPrivacyProof['kind'];
