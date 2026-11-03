import {
  admitDiscoveryFilter,
  parseDiscoveryFilter,
  type DiscoveryFilterDocument,
  type FilterDocument,
  type FilterRelease,
} from '@rezics/filter';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import canonicalize from 'canonicalize';
import type { Pool } from 'pg';
import { ProblemError } from '../http/problem.ts';
import type { WorkAllowance, WorkReceipt } from '../library/collection-source.ts';
import type { LeafOptions } from '../semantic/scope-leaf-evidence.ts';
import {
  compileCurrentOwnerFilter,
  compileCurrentRealmFilter,
  type CurrentRealmFilterPlan,
} from './current-filter-plan.ts';
import { evaluateScopeSubjects, ScopeWork, zeroScopeWork } from './scope-execution.ts';
import type { RelationFacetMatch } from './source.ts';

import {
  createRealmSubjectSource,
  type RealmSubjectObservation,
  type RealmSubjectMembership,
  type RealmSubjectSource,
  type RealmSubjectDisclosure,
  type RealmSubjectMaintenance,
} from '../content/realm-subject-source.ts';
export type {
  RealmSubjectObservation,
  RealmSubjectResolution,
  RealmSubjectMembership,
  RealmSubjectSource,
  RealmSubjectDisclosure,
  RealmSubjectMaintenance,
} from '../content/realm-subject-source.ts';

/** Native composition belongs to Content. Supplying only structural census or exact
 * candidate disclosure cannot establish live population readiness.
 */
export type RealmSubjectCapabilities = Readonly<{
  disclosure: RealmSubjectDisclosure;
  maintenance: RealmSubjectMaintenance;
}>;

const prepared: unique symbol = Symbol('Realm population scope');
export type PreparedRealmScope = Readonly<{
  [prepared]: true;
  /** Population readiness is not a canonical useful Search page. */
  readiness: 'population_ready';
  basis: string;
}>;
type State = Readonly<{
  plan: CurrentRealmFilterPlan;
  observations: ReadonlyMap<string, RealmSubjectObservation>;
  release: Readonly<{ digest: string; release: FilterRelease }>;
}>;
function notReady(): never {
  throw new ProblemError('semantic_not_ready', { headers: { 'retry-after': '1' } });
}
function immutable<T extends object>(value: T): T {
  for (const child of Object.values(value)) if (child && typeof child === 'object') immutable(child);
  return Object.freeze(value);
}

/** Additive native preparation/evaluation boundary on the real service-bound Scope.
 * This does not activate public mixed-kind admission or claim ready ordered pages.
 */
export function createRealmScopeSource(input: {
  pool: Pool;
  reader?: LeafOptions;
  source?: RealmSubjectSource;
  capabilities?: RealmSubjectCapabilities;
  release: (digest?: string) => Promise<Readonly<{ digest: string; release: FilterRelease }> | null>;
}) {
  const source = input.source ?? createRealmSubjectSource({ pool: input.pool, ...input.capabilities });
  const states = new WeakMap<PreparedRealmScope, State>();
  function reader(): LeafOptions {
    if (!input.reader || Date.now() >= input.reader.deadline) notReady();
    return input.reader;
  }
  function state(scope: PreparedRealmScope): State {
    const value = states.get(scope);
    if (!value) throw new TypeError('Foreign Realm scope');
    return value;
  }
  async function current(value: State, work: ScopeWork) {
    const context = reader();
    work.consume({ ...zeroScopeWork(), statements: 1, nativePoints: 1, nativeRows: 1, bytes: 262144 });
    if (!isDeepStrictEqual(await input.release(value.release.digest), value.release)) notReady();
    // Do not let true OR or NOT bypass ANY resource's current authority.
    for (const observation of value.observations.values()) {
      const result = await source.current(observation, context, work);
      if (result === 'concealed') throw new ProblemError('not_found');
      if (result !== 'current') notReady();
    }
  }
  return {
    /** The admitted, already resolved Realm resources drive separate finite source frontiers. */
    realms(scope: PreparedRealmScope): readonly string[] {
      return [...state(scope).observations.keys()].sort();
    },
    async prepare(
      filter: DiscoveryFilterDocument,
      allowance: WorkAllowance,
    ): Promise<Readonly<{ scope: PreparedRealmScope; work: WorkReceipt }>> {
      const work = new ScopeWork(allowance);
      const context = reader();
      work.consume({ ...zeroScopeWork(), statements: 1, nativePoints: 1, nativeRows: 1, bytes: 262144 });
      const release = await input.release();
      if (!release) notReady();
      const admitted = admitDiscoveryFilter(parseDiscoveryFilter(filter), release.release, new Set(), { owner: true });
      const plan = compileCurrentRealmFilter(admitted);
      if (!plan.leaves.some((leaf) => leaf.kind === 'realm')) throw new TypeError('Missing Realm condition');
      const observations = new Map<string, RealmSubjectObservation>();
      let concealed = false;
      let unavailable = false;
      for (const leaf of plan.leaves) {
        if (leaf.kind !== 'realm') continue;
        const result = await source.resolve(leaf.id, context, work);
        concealed ||= result.state === 'concealed';
        unavailable ||= result.state === 'unavailable';
        if (result.state === 'ready') {
          if (result.observation.realm !== leaf.id || !result.observation.revision) notReady();
          // Content retains native dependencies in a WeakMap keyed by this exact handle.
          // Freeze the locator in place; cloning it would retire a current observation.
          observations.set(leaf.id, Object.freeze(result.observation));
        }
      }
      if (concealed) throw new ProblemError('not_found');
      if (unavailable) notReady();
      const basis = createHash('sha256')
        .update(canonicalize({ filter: admitted, release, observations: [...observations] })!)
        .digest('hex');
      const scope: PreparedRealmScope = Object.freeze({
        [prepared]: true as const,
        readiness: 'population_ready',
        basis,
      });
      const value = { plan, observations, release: immutable(structuredClone(release)) };
      await current(value, work);
      states.set(scope, value);
      return { scope, work: work.receipt() };
    },
    /** Raw producer input for finite preparation. Never a successful Search result page. */
    async sourcePrefix(
      scope: PreparedRealmScope,
      realm: string,
      after: string | null,
      limit: number,
      allowance: WorkAllowance,
    ) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 32) throw new RangeError('Invalid Realm prefix limit');
      const value = state(scope);
      const observation = value.observations.get(realm);
      if (!observation) throw new TypeError('Realm absent from scope');
      const work = new ScopeWork(allowance);
      await current(value, work);
      const prefix = await source.prefix(observation, after, limit, reader(), work);
      if (prefix.subjects.length > limit || (!prefix.exhausted && (prefix.after === null || prefix.after === after)))
        notReady();
      await current(value, work);
      return { ...prefix, basis: scope.basis, work: work.receipt() };
    },
    /** Preparation-only full catalogue/Realm predicate, using the existing native
     * catalogue evaluator and its ledger. Final Search disclosure still requires the
     * canonical prepared Source observation. Unknown evidence cannot prove NOT.
     */
    async evaluate(scope: PreparedRealmScope, subjects: readonly string[], allowance: WorkAllowance) {
      if (subjects.length > 100) throw new RangeError('Invalid Realm candidate batch');
      const value = state(scope);
      const work = new ScopeWork(allowance);
      subjects = Object.freeze([...subjects]);
      await current(value, work);
      const columns: (readonly RelationFacetMatch[])[] = [];
      const withheld = new Set<number>();
      for (const leaf of value.plan.leaves) {
        if (leaf.kind === 'realm') {
          // Search admits up to 100 candidates; Content accepts at most 32 per call.
          // Every batch uses the same root and the same native observation. There is
          // no allowance transfer or refill, and current() below fences all batches.
          const matches: RealmSubjectMembership[] = [];
          for (let offset = 0; offset < subjects.length; offset += 32) {
            const batch = subjects.slice(offset, offset + 32);
            const values = await source.match(value.observations.get(leaf.id)!, batch, reader(), work);
            if (values.length !== batch.length) notReady();
            matches.push(...values);
          }
          columns.push(
            matches.map((match, index) => {
              if (match === 'discussed') return true;
              if (match === 'not_published') return false;
              if (match !== 'withheld' && match !== 'unknown') notReady();
              withheld.add(index);
              return 'not_proven';
            }),
          );
        } else {
          const clause = leaf.kind === 'catalogue' ? leaf.clause : null;
          const filter: FilterDocument = clause
            ? clause.facet === 'type'
              ? { type: { in: clause.values } }
              : {
                  statement: {
                    property: clause.property,
                    ...('values' in clause ? { in: clause.values } : { range: clause.range }),
                    ...(clause.qualifiers ? { qualifiers: clause.qualifiers } : {}),
                  },
                }
            : leaf.kind === 'owner'
              ? leaf.leaf
              : (() => {
                  throw new TypeError('Invalid native leaf');
                })();
          const result = await evaluateScopeSubjects({
            pool: input.pool,
            options: reader(),
            plan: compileCurrentOwnerFilter(filter),
            basis: scope.basis,
            subjects,
            work,
            reservation: {
              rawKeys: work.remaining().remaining.candidateKeys,
              native: {
                points: work.remaining().remaining.nativePoints,
                witnesses: work.remaining().remaining.witnessKeys,
                rows: work.remaining().remaining.nativeRows,
                bytes: work.remaining().remaining.bytes,
                emptySeeks: work.remaining().remaining.emptySeeks,
              },
            },
          });
          columns.push(result.values);
        }
      }
      await current(value, work);
      return {
        basis: scope.basis,
        values: subjects.map((_, index) =>
          withheld.has(index) ? ('not_proven' as const) : value.plan.evaluate(columns.map((column) => column[index]!)),
        ),
        work: work.receipt(),
      };
    },
  };
}
