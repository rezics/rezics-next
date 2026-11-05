import type { Pool } from 'pg';
import { deadlineClient } from '../access/authenticate.ts';
import { withConnection } from '../database/pool.ts';
import { readOwnerFilterCandidate, readOwnerFilterCandidateClosure } from '../library/owner-filter-plan.ts';
import { isDeepStrictEqual } from 'node:util';
import { ProblemError } from '../http/problem.ts';
import { readScopeLeafEvidence, type LeafOptions } from '../semantic/scope-leaf-evidence.ts';
import { currentOwnerClauseKey, type CurrentOwnerFilterPlan } from './current-filter-plan.ts';
import { holdsCurrentStatements, holdsCurrentType } from './current-leaf.ts';
import type { FactClause } from './disclosure/check.ts';
import type { ScopeEvaluationProgress, ScopeEvaluationReservation } from './scope-source.ts';
import type { RelationFacetMatch } from './source.ts';
import { evaluateMembersSubject, membersProgress, type MembersExecution } from './scope-members-work.ts';
import { NativeCollectionWork } from '../work-ledger/native-collection-work.ts';
import { zeroScopeWork, type ScopeWork } from '../work-ledger/scope-work.ts';

function match(
  clause: FactClause,
  result: Extract<Awaited<ReturnType<typeof readScopeLeafEvidence>>, { state: 'current' }>,
): RelationFacetMatch {
  const present: RelationFacetMatch =
    clause.facet === 'type'
      ? result.type !== null && holdsCurrentType(result.type, clause)
      : holdsCurrentStatements(
          result.facts.map((fact) => fact.statement),
          clause,
        );
  if (present === true) return true;
  if (present === 'not_proven') return present;
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
    members?: MembersExecution;
    owner?:
      | Readonly<{
          admission: Parameters<typeof readOwnerFilterCandidate>[1];
          binding: Parameters<typeof readOwnerFilterCandidateClosure>[0];
          source: Parameters<typeof readOwnerFilterCandidateClosure>[1];
        }>
      | undefined;
  }>,
) {
  const { plan, subjects, work, reservation, basis } = input;
  const values: RelationFacetMatch[] = [];
  const evidence = new Set<string>();
  let progress: ScopeEvaluationProgress | null = null;
  let resume: ScopeLeafResume | null = null;
  for (const subject of subjects) {
    if (input.members) {
      if (plan.leaves.some((leaf) => leaf.kind !== 'owner')) throw new ProblemError('dependency_unavailable');
      const pending = input.reservation.progress ?? input.resume?.progress;
      if (
        pending?.subject === subject &&
        (pending.basis !== basis ||
          pending.leafOrdinal !== 0 ||
          pending.valueOrdinal !== 0 ||
          pending.phase !== 'selection' ||
          pending.after === null ||
          !/^(?:0|[1-9][0-9]?|100)$/.test(pending.after))
      )
        throw new RangeError('Invalid Members raw progress');
      // Only the retained native raw-key prefix supplies a SQL frontier. A supplied count can be
      // replayed in a fresh factory, but cannot skip unread keys or install a predicate verdict.
      const value = await evaluateMembersSubject(input.members, subject, work);
      values.push(value);
      if (value === 'not_proven') {
        progress = membersProgress(input.members, subject, basis);
        resume = { progress, nativeBasis: basis };
        // A later subject must not overwrite the first unfinished raw position.
        values.push(...subjects.slice(values.length).map(() => 'not_proven' as const));
        break;
      }
      evidence.add(`members:${basis}:${subject}`);
      continue;
    }
    if (plan.leaves.some((leaf) => leaf.kind === 'owner')) {
      // The Library producer owns complete original/terminal support and same-owner
      // native point evidence. Its matcher invokes the same shared Boolean plan.
      // Never treat a missing closure as empty private evidence, even beneath OR.
      const owner = input.owner;
      if (
        !owner ||
        input.options.work ||
        owner.binding.input.actor !== input.options.actor ||
        !isDeepStrictEqual(owner.admission.plan?.leaves, plan.leaves)
      ) {
        values.push('not_proven');
        continue;
      }
      const { pool, options } = input;
      const native = new NativeCollectionWork(work.remaining(), options.deadline);
      try {
        const read = async () => {
          const closure = await readOwnerFilterCandidateClosure(owner.binding, owner.source, subject, native);
          if (closure.status !== 'complete') return 'not_proven' as const;
          if (closure.closure.subjectId !== subject) throw new TypeError('Foreign native owner closure');
          // Library resolves catalogue evidence as well. An unavailable public branch
          // must never be bypassed by an otherwise true native owner OR branch.
          if (
            plan.leaves.some(
              (leaf) =>
                leaf.kind === 'catalogue' &&
                closure.closure.catalogue.get(currentOwnerClauseKey(leaf))?.state !== 'current',
            )
          )
            return 'not_proven' as const;
          const control = native.reserve({ ...zeroScopeWork(), nativePoints: 1, statements: 3, bytes: 256 });
          control.dispatch();
          try {
            return await withConnection(pool, async (connection) => {
              const client = deadlineClient(connection, options.deadline);
              await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
              try {
                const value = await readOwnerFilterCandidate(client, owner.admission, closure.closure, native);
                await client.query('COMMIT');
                return value;
              } catch (error) {
                await client.query('ROLLBACK');
                throw error;
              }
            });
          } finally {
            control.settle();
          }
        };
        const first = await read();
        // A scalar result is never retained permission. Repeat native evidence before
        // the enclosing source/Scope70 guards settle the output or progress commit.
        values.push(first === 'not_proven' || (await read()) !== first ? 'not_proven' : first);
      } finally {
        work.native(native.receipt());
      }
      continue;
    }
    const results: RelationFacetMatch[] = [];
    for (const [leafOrdinal, native] of plan.leaves.entries()) {
      if (native.kind === 'owner') throw new TypeError('Owner leaf requires native Library evidence');
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
        input.pool,
        { subject, leaf: clause, after, revalidate: null, budget },
        input.options,
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
                .filter((fact) => holdsCurrentStatements([fact.statement], clause) === true)
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
            input.pool,
            { subject, leaf: clause, after: null, revalidate: witness, budget: finalBudget },
            input.options,
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
                  holdsCurrentStatements([fact.statement], clause) === true,
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
