import type { PrivacyReductionHead } from '../semantic/public-filter-source-contract.ts';
import { proveKindCount, type KindCountProof } from './kind-count-proof.ts';
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

export type QueryPrivacyDecision =
  | Readonly<{ status: 'current'; stale: false }>
  | Readonly<{
      status: 'current';
      stale: true;
      unacknowledged: readonly PrivacyReductionHead[];
      changed: readonly PrivacyReductionHead[];
    }>
  | Readonly<{ status: 'preparing'; reason: 'routing_incomplete' | 'blocking' }>;

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

export type QueryPrivacyProof =
  | QueryPrivacyCursorProof
  | QueryPrivacyKindWitness
  | QueryPrivacyAggregateProof
  | Readonly<{ kind: 'withheld' }>;

const barrierScopes = new Set<QueryPrivacyBarrierScope>(['filter_or_order', 'returned_subject', 'unresolved']);
const barrierPhases = new Set<QueryPrivacyBarrierPhase>(['pending', 'changed']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isHead(value: unknown): value is PrivacyReductionHead {
  if (!isRecord(value) || typeof value.position !== 'bigint' || value.position < 0n) return false;
  return (
    Number.isSafeInteger(value.partition) &&
    (value.partition as number) >= 0 &&
    Number.isSafeInteger(value.epoch) &&
    (value.epoch as number) >= 0
  );
}

function isBarrier(value: unknown): value is QueryPrivacyBarrier {
  if (!isRecord(value) || !isHead(value.head) || typeof value.scope !== 'string' || typeof value.phase !== 'string')
    return false;
  return (
    barrierScopes.has(value.scope as QueryPrivacyBarrierScope) &&
    barrierPhases.has(value.phase as QueryPrivacyBarrierPhase)
  );
}

/** Reject a malformed observation rather than treating missing routing as clean. */
export function admitQueryPrivacyHeads(value: unknown): QueryPrivacyHeads {
  if (!isRecord(value)) throw new TypeError('Query privacy observation must be an object');
  if (typeof value.routingComplete !== 'boolean')
    throw new TypeError('Query privacy routing completeness must be boolean');
  const unacknowledged = value.unacknowledged ?? value.pending;
  if (!Array.isArray(unacknowledged) || !unacknowledged.every(isHead))
    throw new TypeError('Query privacy unacknowledged heads must be native privacy heads');
  if (!Array.isArray(value.changed) || !value.changed.every(isHead))
    throw new TypeError('Query privacy changed heads must be native privacy heads');
  if (!Array.isArray(value.blocking) || !value.blocking.every(isBarrier))
    throw new TypeError('Query privacy blocking must be classified native barriers');
  return {
    routingComplete: value.routingComplete,
    unacknowledged,
    changed: value.changed,
    blocking: value.blocking,
  };
}

/**
 * Currentness for disclosure. Relevant pending/changed heads block. Irrelevant unacknowledged or
 * already-changed heads on this observation are trusted stale and remain current.
 */
export function queryPrivacyCurrentness(heads: QueryPrivacyHeads): QueryPrivacyDecision {
  if (!heads.routingComplete) return { status: 'preparing', reason: 'routing_incomplete' };
  if (heads.blocking.length) return { status: 'preparing', reason: 'blocking' };
  if (heads.unacknowledged.length === 0 && heads.changed.length === 0) return { status: 'current', stale: false };
  return {
    status: 'current',
    stale: true,
    unacknowledged: heads.unacknowledged,
    changed: heads.changed,
  };
}

/** True when this observation may disclose hits, exclusion, order and current fields. */
export function observationIsDisclosable(heads: QueryPrivacyHeads): boolean {
  return queryPrivacyCurrentness(heads).status === 'current';
}

/** Trusted stale: Source classified no relevant barrier, so the delayed index may still serve. */
export function trustedStaleObservation(decision: QueryPrivacyDecision): boolean {
  return decision.status === 'current' && decision.stale;
}

export function queryPrivacyPreparing(
  decision: QueryPrivacyDecision,
): decision is Extract<QueryPrivacyDecision, { status: 'preparing' }> {
  return decision.status === 'preparing';
}

export function admitQueryPrivacyCursor(input: {
  observation: string;
  execution?: string;
  consumed: number;
}): QueryPrivacyCursorProof {
  if (typeof input.observation !== 'string' || !input.observation)
    throw new TypeError('An admitted cursor names a retained observation');
  if (input.execution !== undefined && (typeof input.execution !== 'string' || !input.execution))
    throw new TypeError('An admitted cursor execution must be a retained identifier');
  if (!Number.isSafeInteger(input.consumed) || input.consumed < 0)
    throw new TypeError('An admitted cursor consumed prefix must be a nonnegative integer');
  return {
    kind: 'admitted-cursor',
    observation: input.observation,
    execution: input.execution,
    consumed: input.consumed,
  };
}

/**
 * Replay uses the admitted locator only after currentness. A relevant reduction restarts;
 * trusted stale continues and re-discloses remaining hits. The cursor never certifies totals.
 */
export function replayQueryPrivacyCursor(
  admitted: QueryPrivacyCursorProof,
  currentness: QueryPrivacyDecision,
): 'continue' | 'restart' | 'preparing' {
  if (admitted.kind !== 'admitted-cursor') throw new TypeError('Cursor replay requires an admitted cursor proof');
  if (currentness.status === 'preparing') return currentness.reason === 'blocking' ? 'restart' : 'preparing';
  return 'continue';
}

export function queryPrivacyKindWitness(kind: string, proof: KindCountProof): QueryPrivacyKindWitness {
  return { kind: 'kind-witness', evidence: proveKindCount(kind, { ...proof, aggregateProof: false }) };
}

export function queryPrivacyExactAggregate(kind: string, proof: KindCountProof): QueryPrivacyAggregateProof {
  return { kind: 'exact-aggregate', evidence: proveKindCount(kind, proof) };
}

/** Sampled hits are witnesses. They never become an exact total, including an exact zero. */
export function sampledHitsCannotCertifyTotal(proof: KindCountProof): boolean {
  if (proof.continuation || !proof.exhausted || !proof.aggregateProof) return true;
  return false;
}

export type QueryPrivacyProofSet = Readonly<{
  cursor: QueryPrivacyCursorProof | null;
  kinds: ReadonlyMap<string, QueryPrivacyKindWitness>;
  aggregates: ReadonlyMap<string, QueryPrivacyAggregateProof>;
}>;

/**
 * Build the three independent proofs for one executed predicate. A continuation keeps kind
 * witnesses and aggregates withheld. Exact aggregates require current whole-query proof.
 */
export function queryPrivacyProofs(input: {
  currentness: QueryPrivacyDecision;
  cursor?: { observation: string; execution?: string; consumed: number };
  kinds: Iterable<string>;
  witnesses: ReadonlyMap<string, number>;
  continuation: boolean;
  exhausted: boolean;
  aggregateProof: boolean;
}): QueryPrivacyProofSet {
  const cursor = input.cursor === undefined ? null : admitQueryPrivacyCursor(input.cursor);
  const kinds = new Map<string, QueryPrivacyKindWitness>();
  const aggregates = new Map<string, QueryPrivacyAggregateProof>();
  if (input.currentness.status !== 'current') return { cursor, kinds, aggregates };
  const base: KindCountProof = {
    continuation: input.continuation,
    exhausted: input.exhausted,
    aggregateProof: false,
    witnesses: input.witnesses,
  };
  for (const kind of input.kinds) kinds.set(kind, queryPrivacyKindWitness(kind, base));
  if (input.continuation || !input.exhausted || !input.aggregateProof) return { cursor, kinds, aggregates };
  const exact: KindCountProof = { ...base, aggregateProof: true };
  for (const kind of input.kinds) aggregates.set(kind, queryPrivacyExactAggregate(kind, exact));
  return { cursor, kinds, aggregates };
}

export function queryPrivacyProofKind(proof: QueryPrivacyProof): QueryPrivacyProof['kind'] {
  return proof.kind;
}
