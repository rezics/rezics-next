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
import { routeOf } from '../route/route.ts';

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
  anchors: readonly string[] | null;
  observations: ReadonlyMap<string, RealmSubjectObservation>;
  release: Readonly<{ digest: string; release: FilterRelease }>;
}>;
const refinement: unique symbol = Symbol('Realm refinement frontier');
/** Factory-local input position, never a public Search continuation or ready page. */
export type RealmRefinementFrontier = Readonly<{
  [refinement]: true;
  basis: string;
}>;

/** A cover must include the complete Boolean population. An AND may use one
 * covering child; every OR branch needs a cover. Negation swaps these rules.
 * Catalogue/owner complements cannot be enumerated from a Realm prefix.
 */
function preparationAnchors(filter: DiscoveryFilterDocument, negated = false): readonly string[] | null {
  if ('not' in filter) return preparationAnchors(filter.not, !negated);
  if ('realm' in filter) return negated ? null : [filter.realm.id];
  if (!('and' in filter) && !('or' in filter)) return null;
  const children = ('and' in filter ? filter.and : filter.or).map((child) => preparationAnchors(child, negated));
  const intersection = 'and' in filter !== negated;
  if (intersection) return children.find((child) => child !== null) ?? null;
  if (children.some((child) => child === null)) return null;
  return [...new Set(children.flatMap((child) => child!))];
}

function validPrefix(
  prefix: Readonly<{
    subjects: readonly string[];
    after: string | null;
    exhausted: boolean;
  }>,
  after: string | null,
  limit: number,
) {
  if (
    prefix.subjects.length > limit ||
    prefix.subjects.some((subject) => routeOf(subject) === null) ||
    (!prefix.exhausted && (typeof prefix.after !== 'string' || !prefix.after || prefix.after === after))
  )
    notReady();
}
function notReady(): never {
  throw new ProblemError('semantic_not_ready', {
    headers: { 'retry-after': '1' },
  });
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
  const frontiers = new WeakMap<
    RealmRefinementFrontier,
    { scope: PreparedRealmScope; anchor: number; after: string | null }
  >();
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
    work.consume({
      ...zeroScopeWork(),
      statements: 1,
      nativePoints: 1,
      nativeRows: 1,
      bytes: 262144,
    });
    if (!isDeepStrictEqual(await input.release(value.release.digest), value.release)) notReady();
    // Do not let true OR or NOT bypass ANY resource's current authority.
    for (const observation of value.observations.values()) {
      const result = await source.current(observation, context, work);
      if (result === 'concealed') throw new ProblemError('not_found');
      if (result !== 'current') notReady();
    }
  }
  const api = {
    async prepare(
      filter: DiscoveryFilterDocument,
      allowance: WorkAllowance,
    ): Promise<Readonly<{ scope: PreparedRealmScope; work: WorkReceipt }>> {
      const work = new ScopeWork(allowance);
      const context = reader();
      work.consume({
        ...zeroScopeWork(),
        statements: 1,
        nativePoints: 1,
        nativeRows: 1,
        bytes: 262144,
      });
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
        .update(
          canonicalize({
            filter: admitted,
            release,
            observations: [...observations],
          })!,
        )
        .digest('hex');
      const scope: PreparedRealmScope = Object.freeze({
        [prepared]: true as const,
        readiness: 'population_ready',
        basis,
      });
      const value = {
        plan,
        anchors: preparationAnchors(admitted),
        observations,
        release: immutable(structuredClone(release)),
      };
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
      validPrefix(prefix, after, limit);
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
    /** Settle exactly one Content window with the COMPLETE current predicate.
     * Sparse windows advance as preparation input; they never become empty public
     * pages. Unknown evidence refuses the whole window, including its successor.
     * The enclosing retained writer must commit subjects and frontier atomically.
     */
    async refinePrefix(
      scope: PreparedRealmScope,
      frontier: RealmRefinementFrontier | null,
      allowance: WorkAllowance,
    ): Promise<
      Readonly<{
        readiness: 'refined_input';
        basis: string;
        subjects: readonly string[];
        frontier: RealmRefinementFrontier | null;
        exhausted: boolean;
        work: WorkReceipt;
      }>
    > {
      const value = state(scope);
      const anchors = value.anchors;
      // Resolve/read authority in prepare(), including unanchored branches, but
      // never turn NOT or a catalogue OR into a truncated Realm-only population.
      if (!anchors?.length) notReady();
      const position = frontier === null ? { scope, anchor: 0, after: null } : frontiers.get(frontier);
      if (!position || position.scope !== scope || (frontier && frontier.basis !== scope.basis))
        throw new TypeError('Foreign Realm refinement frontier');
      const work = new ScopeWork(allowance);
      const page = await api.sourcePrefix(scope, anchors[position.anchor]!, position.after, 32, work.remaining());
      work.native(page.work);
      const subjects = Object.freeze([...new Set(page.subjects)]);
      const evaluated = await api.evaluate(scope, subjects, work.remaining());
      work.native(evaluated.work);
      if (evaluated.values.some((match) => match === 'not_proven')) notReady();
      if (!subjects.length) work.consume({ ...zeroScopeWork(), emptySeeks: 1 });
      const anchor = position.anchor + (page.exhausted ? 1 : 0);
      const exhausted = anchor === anchors.length;
      let next: RealmRefinementFrontier | null = null;
      if (!exhausted) {
        next = Object.freeze({
          [refinement]: true as const,
          basis: scope.basis,
        });
        frontiers.set(next, {
          scope,
          anchor,
          after: page.exhausted ? null : page.after,
        });
      }
      // Even zero accepted candidates retain all resource dependencies observed
      // by the input and evaluator. A writer must not commit after authority loss.
      await current(value, work);
      return {
        readiness: 'refined_input',
        basis: scope.basis,
        subjects: Object.freeze(subjects.filter((_, index) => evaluated.values[index] === true)),
        frontier: next,
        exhausted,
        work: work.receipt(),
      };
    },
    /** Final consumption observes every resource, including excluded/empty input. */
    async revalidate(scope: PreparedRealmScope, allowance: WorkAllowance): Promise<WorkReceipt> {
      const work = new ScopeWork(allowance);
      await current(state(scope), work);
      return work.receipt();
    },
  };
  return api;
}
