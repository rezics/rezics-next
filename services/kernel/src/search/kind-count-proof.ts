import type { DiscoveryKindMetadata, KindCountEvidence } from './discovery-api.ts';
import type { DiscoveryRegistry } from './discovery.ts';
import { validateKindCountEvidence } from './discovery-registry.ts';

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
export function publicCatalogueKindCounts(
  types: Iterable<string>,
  options: Readonly<{ continuation: boolean; exhausted: boolean }>,
): Map<string, number> {
  if (options.continuation) return new Map();
  const witnesses = new Map<string, number>();
  for (const type of types) witnesses.set(type, (witnesses.get(type) ?? 0) + 1);
  const proof: KindCountProof = {
    continuation: false,
    exhausted: options.exhausted,
    aggregateProof: false,
    witnesses,
  };
  const counts = new Map<string, number>();
  for (const kind of witnesses.keys()) {
    const evidence = proveKindCount(kind, proof);
    if ('value' in evidence && !evidence.exact) counts.set(kind, evidence.value);
  }
  return counts;
}

export function proveKindCount(kind: string, proof: KindCountProof): KindCountEvidence {
  if (proof.continuation) return { kind, unavailable: true };
  const value = proof.witnesses.get(kind) ?? 0;
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('Kind witnesses must be a safe count');
  if (proof.aggregateProof && proof.exhausted) return { kind, value, exact: true };
  if (value > 0) return { kind, value, exact: false };
  return { kind, unavailable: true };
}

export function projectKindDirectoryCounts<Entry extends { kind: string; metadata: DiscoveryKindMetadata }>(
  registry: DiscoveryRegistry,
  entries: readonly Entry[],
  proof: KindCountProof,
): Array<DiscoveryKindMetadata & { count: KindCountEvidence }> {
  return entries.map((entry) => ({
    ...entry.metadata,
    count: validateKindCountEvidence(registry, proveKindCount(entry.kind, proof)),
  }));
}
