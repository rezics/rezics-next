import type { Pool } from 'pg';
import { isDeepStrictEqual } from 'node:util';
import { ProblemError } from '../http/problem.ts';
import type { WorkAllowance, WorkDimensions, WorkReceipt } from '../library/collection-source.ts';
import { readScopeLeafEvidence, type LeafOptions, type LeafWork } from '../semantic/scope-leaf-evidence.ts';
import type { IdentityScopeWork } from '../semantic/identity-scope-types.ts';
import type { PublicFilterCost } from '../semantic/public-filter-source-contract.ts';
import type { CurrentOwnerFilterPlan } from './current-filter-plan.ts';
import { holdsCurrentStatements, holdsCurrentType } from './current-leaf.ts';
import type { FactClause } from './disclosure/check.ts';
import type { ScopeEvaluationProgress, ScopeEvaluationReservation } from './scope-source.ts';
import type { RelationFacetMatch } from './source.ts';

export const scopeWorkAxes = [
  'candidateKeys',
  'nativeRows',
  'identityMetadataRows',
  'emptySeeks',
  'nativePoints',
  'witnessKeys',
  'statements',
  'bytes',
] as const;
export function zeroScopeWork(): WorkDimensions {
  return {
    candidateKeys: 0,
    nativeRows: 0,
    identityMetadataRows: 0,
    emptySeeks: 0,
    nativePoints: 0,
    witnessKeys: 0,
    statements: 0,
    bytes: 0,
  };
}
/** Compatibility ceilings are independent of the candidate reservation. They never grow on refill. */
export function scopeAllowance(keys: number, reservationId: string, remaining?: WorkDimensions): WorkAllowance {
  return {
    reservationId,
    remaining: remaining ?? {
      candidateKeys: keys,
      nativeRows: 65536,
      identityMetadataRows: 16384,
      emptySeeks: 256,
      nativePoints: 4096,
      witnessKeys: 8192,
      statements: 8192,
      bytes: 4 * 1024 * 1024,
    },
  };
}
export class ScopeWork {
  private spent = { ...zeroScopeWork() };
  private readonly root: WorkAllowance;
  constructor(root: WorkAllowance) {
    this.root = Object.freeze({ ...root, remaining: Object.freeze({ ...root.remaining }) });
    if (!root.reservationId) throw new RangeError('Missing scope reservation');
    for (const axis of scopeWorkAxes)
      if (!Number.isSafeInteger(root.remaining[axis]) || root.remaining[axis] < 0)
        throw new RangeError('Invalid scope reservation');
  }
  remaining(): WorkAllowance {
    const remaining = { ...zeroScopeWork() };
    for (const axis of scopeWorkAxes) remaining[axis] = this.root.remaining[axis] - this.spent[axis];
    return { reservationId: this.root.reservationId, remaining };
  }
  consume(used: WorkDimensions): void {
    for (const axis of scopeWorkAxes)
      if (!Number.isSafeInteger(used[axis]) || used[axis] < 0 || used[axis] > this.remaining().remaining[axis])
        throw new RangeError(`Native scope work exceeded ${axis}`);
    for (const axis of scopeWorkAxes) this.spent[axis] += used[axis];
  }
  receipt(): WorkReceipt {
    return { reservationId: this.root.reservationId, used: { ...this.spent } };
  }
  native(receipt: WorkReceipt): void {
    if (receipt.reservationId !== this.root.reservationId) throw new TypeError('Foreign scope reservation');
    this.consume(receipt.used);
  }
  identity(work: IdentityScopeWork): void {
    this.consume({
      ...zeroScopeWork(),
      identityMetadataRows: work.rows,
      nativePoints: work.points,
      statements: work.statements,
      bytes: work.bytes,
    });
  }
  public(cost: PublicFilterCost): void {
    // Public producers expose their own independent ceilings. Input keys and point work
    // still settle into this root; output slots cannot refund native candidate work.
    this.consume({
      ...zeroScopeWork(),
      candidateKeys: cost.inputKeys,
      nativePoints: cost.accessPoints + cost.dependencyPoints,
      statements: cost.engineSearches + cost.engineIteratorSteps + cost.resultWrites + cost.frontierWrites,
    });
  }
  leaf(used: LeafWork): void {
    this.consume({
      ...zeroScopeWork(),
      candidateKeys: used.keys,
      nativePoints: used.points,
      witnessKeys: used.witnesses,
      nativeRows: used.rows,
      bytes: used.bytes,
      emptySeeks: used.emptySeeks,
    });
  }
  leafBudget(): LeafWork | null {
    const r = this.remaining().remaining;
    const budget = {
      keys: Math.min(101, r.candidateKeys),
      points: r.nativePoints,
      witnesses: Math.min(100, r.witnessKeys),
      rows: r.nativeRows,
      bytes: r.bytes,
      emptySeeks: r.emptySeeks,
    };
    return Object.values(budget).every((value) => value > 0) ? budget : null;
  }
}

function match(
  clause: FactClause,
  result: Extract<Awaited<ReturnType<typeof readScopeLeafEvidence>>, { state: 'current' }>,
): RelationFacetMatch {
  const present =
    clause.facet === 'type'
      ? result.type !== null && holdsCurrentType(result.type, clause)
      : holdsCurrentStatements(
          result.facts.map((fact) => fact.statement),
          clause,
        );
  if (present) return true;
  return result.coverage !== null && result.coverage.basis === result.basis && result.progress === null
    ? false
    : 'not_proven';
}

/** Retained raw native position only; it contains no cached verdict or authority. */
export type ScopeLeafResume = Readonly<{ progress: ScopeEvaluationProgress; nativeBasis: string }>;

/** Native current evidence, one matcher and one shared ledger across subjects/leaves/replay.
 * No engine hit, sampled SubjectSnapshot, callback verdict or point mapping certifies absence.
 */
export async function evaluateScopeSubjects(
  input: Readonly<{
    pool: Pool;
    options: LeafOptions;
    plan: CurrentOwnerFilterPlan;
    basis: string;
    subjects: readonly string[];
    reservation: ScopeEvaluationReservation;
    work: ScopeWork;
    resume?: ScopeLeafResume | null;
  }>,
) {
  const { pool, options, plan, subjects, work, reservation, basis } = input;
  const values: RelationFacetMatch[] = [];
  const evidence = new Set<string>();
  let progress: ScopeEvaluationProgress | null = null;
  let resume: ScopeLeafResume | null = null;
  for (const subject of subjects) {
    const results: RelationFacetMatch[] = [];
    for (const [leafOrdinal, native] of plan.leaves.entries()) {
      // Library owns current owner evidence. No scalar private-field copy or Boolean hook here.
      if (native.kind === 'owner') {
        results.push('not_proven');
        continue;
      }
      const clause = native.clause;
      const budget = work.leafBudget();
      if (!budget) {
        results.push('not_proven');
        continue;
      }
      const pending = reservation.progress;
      const after =
        pending?.subject === subject &&
        pending.leafOrdinal === leafOrdinal &&
        input.resume &&
        isDeepStrictEqual(input.resume.progress, pending)
          ? {
              basis: input.resume.nativeBasis,
              phase: pending.phase,
              valueOrdinal: pending.valueOrdinal,
              after: pending.after,
            }
          : null;
      const result = await readScopeLeafEvidence(
        pool,
        { subject, leaf: clause, after, revalidate: null, budget },
        options,
      );
      work.leaf(result.usage);
      if (result.state !== 'current') {
        if (result.state === 'basis_changed') throw new ProblemError('semantic_not_ready');
        results.push('not_proven');
        continue;
      }
      if (after && result.basis !== after.basis) throw new ProblemError('semantic_not_ready');
      let value = match(clause, result);
      if (value === 'not_proven' && result.progress && progress === null) {
        progress = { ...result.progress, subject, basis, leafOrdinal };
        resume = { progress, nativeBasis: result.basis };
      }
      if (value !== 'not_proven') {
        // Re-read native evidence with the SAME caller authority, even for complete negatives.
        // The scoped Source is independently revalidated by the enclosing operation afterwards.
        const witnesses =
          value === true && clause.facet === 'statement'
            ? result.facts
                .filter((fact) => holdsCurrentStatements([fact.statement], clause))
                .slice(0, 1)
                .map((fact) => fact.witness)
            : [];
        const probes: (string | null)[] = witnesses.length ? [...new Set(witnesses)] : [null];
        for (const witness of probes) {
          const finalBudget = work.leafBudget();
          if (!finalBudget) {
            value = 'not_proven';
            break;
          }
          const final = await readScopeLeafEvidence(
            pool,
            { subject, leaf: clause, after: null, revalidate: witness, budget: finalBudget },
            options,
          );
          work.leaf(final.usage);
          if (final.state !== 'current' || final.basis !== result.basis) {
            value = 'not_proven';
            break;
          }
          if (witness === null && match(clause, final) !== value) {
            value = 'not_proven';
            break;
          }
          if (witness !== null) {
            if (
              !final.facts.some(
                (fact) =>
                  fact.witness === witness &&
                  clause.facet === 'statement' &&
                  holdsCurrentStatements([fact.statement], clause),
              )
            ) {
              value = 'not_proven';
              break;
            }
            evidence.add(witness);
          }
        }
      }
      results.push(value);
    }
    values.push(plan.evaluate(results));
  }
  return { values, evidence: [...evidence], progress, resume };
}
