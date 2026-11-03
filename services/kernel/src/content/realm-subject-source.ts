import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import type { LeafOptions } from '../semantic/scope-leaf-evidence.ts';
import type { WorkDimensions } from '../library/collection-source.ts';
import { ScopeWork, zeroScopeWork } from '../search/scope-execution.ts';
import { ProblemError } from '../http/problem.ts';
import {
  createRealmSubjectCandidates,
  REALM_SUBJECT_RAW_LIMIT,
  realmSubjectRoute,
  type CandidateKey,
  type RealmSubjectCandidate,
  type RealmSubjectCoverage,
} from './realm-subject-candidates.ts';
export type { RealmSubjectCandidate, RealmSubjectCoverage } from './realm-subject-candidates.ts';

export type RealmSubjectObservation = Readonly<{ realm: string; revision: string }>;
export type RealmSubjectResolution =
  | Readonly<{ state: 'ready'; observation: RealmSubjectObservation }>
  | Readonly<{ state: 'concealed' | 'unavailable' }>;
export type RealmSubjectMembership = 'discussed' | 'not_published' | 'withheld' | 'unknown';
type Current = 'current' | 'changed' | 'concealed' | 'unavailable';
type Context = Readonly<{ reader: LeafOptions; work: ScopeWork }>;
/** Supplied by the separate current-disclosure owner. All methods use the caller root;
 * dependencies bind actor, Access, Realm/place, opening, original and terminal identity.
 * Currentness also revalidates every Subject/candidate dependency added during a page.
 * A rejected candidate is not_published; uncertainty must be withheld or unknown.
 */
export interface RealmSubjectDisclosure {
  readonly bounds: Readonly<Record<'resolve' | 'current' | 'candidate' | 'subject', WorkDimensions>>;
  resolve(
    realm: string,
    context: Context,
  ): Promise<Readonly<{ state: 'ready'; dependency: string }> | Readonly<{ state: 'concealed' | 'unavailable' }>>;
  current(realm: string, dependency: string, context: Context): Promise<Current>;
  candidate(candidate: RealmSubjectCandidate, dependency: string, context: Context): Promise<RealmSubjectMembership>;
  subject(
    subject: string,
    dependency: string,
    context: Context,
  ): Promise<Readonly<{ state: 'readable'; terminal: string }> | Readonly<{ state: 'withheld' | 'unknown' }>>;
}
/** Live maintenance proves every source cut, subsequent writes and identity repairs.
 * A token binds the exact native generation/revision, not just an empty eligible page.
 */
export interface RealmSubjectMaintenance {
  readonly bounds: Readonly<Record<'observe' | 'current', WorkDimensions>>;
  observe(realm: string, coverage: RealmSubjectCoverage, context: Context): Promise<string | null>;
  current(
    realm: string,
    coverage: RealmSubjectCoverage,
    token: string,
    context: Context,
  ): Promise<'current' | 'changed' | 'unavailable'>;
}
export interface RealmSubjectSource {
  resolve(realm: string, reader: LeafOptions, work: ScopeWork): Promise<RealmSubjectResolution>;
  current(observation: RealmSubjectObservation, reader: LeafOptions, work: ScopeWork): Promise<Current>;
  prefix(
    observation: RealmSubjectObservation,
    after: string | null,
    limit: number,
    reader: LeafOptions,
    work: ScopeWork,
  ): Promise<Readonly<{ subjects: readonly string[]; after: string | null; exhausted: boolean }>>;
  match(
    observation: RealmSubjectObservation,
    subjects: readonly string[],
    reader: LeafOptions,
    work: ScopeWork,
  ): Promise<readonly RealmSubjectMembership[]>;
}
type State = { coverage: RealmSubjectCoverage; dependency: string; live: string; reader: LeafOptions };
type Frontier = { revision: string; key: CandidateKey; emitted: string | null };
const unavailable = (): never => {
  throw new ProblemError('dependency_unavailable');
};
function charge(work: ScopeWork) {
  work.consume({ ...zeroScopeWork(), nativeRows: 2, nativePoints: 2, statements: 5, bytes: 1024 });
}
function admitRows(work: ScopeWork, limit: number) {
  const available = work.remaining().remaining;
  if (available.candidateKeys < limit || available.nativeRows < limit || available.bytes < limit * 4096) unavailable();
}
function chargeRows(work: ScopeWork, rows: number) {
  work.consume({ ...zeroScopeWork(), candidateKeys: rows, nativeRows: rows, bytes: rows * 4096 });
}
async function bounded<T>(context: Context, bound: WorkDimensions, run: () => Promise<T>): Promise<T> {
  const before = context.work.remaining().remaining;
  for (const axis of Object.keys(before) as (keyof WorkDimensions)[]) {
    if (!Number.isSafeInteger(bound[axis]) || bound[axis] < 0 || bound[axis] > before[axis]) unavailable();
  }
  const result = await run();
  const after = context.work.remaining().remaining;
  for (const axis of Object.keys(before) as (keyof WorkDimensions)[])
    if (before[axis] - after[axis] > bound[axis]) throw new RangeError(`Realm disclosure exceeded ${axis}`);
  if (Date.now() >= context.reader.deadline) unavailable();
  return result;
}
function frontier(token: string, revision: string): Frontier {
  if (token.length > 1024) throw new TypeError('Invalid Realm frontier');
  const value = JSON.parse(Buffer.from(token, 'base64url').toString()) as Frontier;
  if (
    value.revision !== revision ||
    !value.key ||
    ![value.key.terminal, value.key.original, value.key.thread].every(
      (id) => typeof id === 'string' && realmSubjectRoute(id) >= 0,
    ) ||
    (value.emitted !== null && value.emitted !== value.key.terminal)
  )
    throw new TypeError('Invalid Realm frontier');
  return value;
}
const encode = (value: Frontier) => Buffer.from(JSON.stringify(value)).toString('base64url');
const same = (a: RealmSubjectCoverage, b: RealmSubjectCoverage) =>
  a.ownerEpoch === b.ownerEpoch &&
  a.generation === b.generation &&
  a.revision === b.revision &&
  a.unresolved === b.unresolved;

/** No default evaluator, lifecycle stand-in or production registration. */
export function createRealmSubjectSource(input: {
  pool: Pool;
  disclosure?: RealmSubjectDisclosure;
  maintenance?: RealmSubjectMaintenance;
}): RealmSubjectSource {
  const store = createRealmSubjectCandidates(input.pool);
  const states = new WeakMap<RealmSubjectObservation, State>();
  const disclosure = input.disclosure,
    maintenance = input.maintenance;
  async function current(observation: RealmSubjectObservation, reader: LeafOptions, work: ScopeWork): Promise<Current> {
    const state = states.get(observation);
    if (!state || reader !== state.reader) return 'changed';
    if (!disclosure || !maintenance || Date.now() >= reader.deadline) return 'unavailable';
    const context = { reader, work };
    const authority = await bounded(context, disclosure.bounds.current, () =>
      disclosure.current(observation.realm, state.dependency, context),
    );
    if (authority !== 'current') return authority;
    charge(work);
    const coverage = await store.observe(observation.realm, reader.deadline);
    if (!coverage || !same(state.coverage, coverage) || coverage.unresolved !== '0') return 'changed';
    return bounded(context, maintenance.bounds.current, () =>
      maintenance.current(observation.realm, coverage, state.live, context),
    );
  }
  async function requireCurrent(observation: RealmSubjectObservation, reader: LeafOptions, work: ScopeWork) {
    if ((await current(observation, reader, work)) !== 'current') unavailable();
    return states.get(observation)!;
  }
  return {
    async resolve(realm, reader, work) {
      realmSubjectRoute(realm);
      if (!disclosure || Date.now() >= reader.deadline) return { state: 'unavailable' };
      const context = { reader, work };
      const authority = await bounded(context, disclosure.bounds.resolve, () => disclosure.resolve(realm, context));
      if (authority.state !== 'ready') return authority;
      if (!maintenance) return { state: 'unavailable' };
      charge(work);
      const coverage = await store.observe(realm, reader.deadline);
      if (!coverage || coverage.unresolved !== '0') return { state: 'unavailable' };
      const live = await bounded(context, maintenance.bounds.observe, () =>
        maintenance.observe(realm, coverage, context),
      );
      if (!live) return { state: 'unavailable' };
      const observation = Object.freeze({
        realm,
        revision: createHash('sha256')
          .update(JSON.stringify([coverage, authority.dependency, live]))
          .digest('hex'),
      });
      states.set(observation, { coverage, dependency: authority.dependency, live, reader });
      const fresh = await current(observation, reader, work);
      return fresh === 'current'
        ? { state: 'ready', observation }
        : { state: fresh === 'concealed' ? 'concealed' : 'unavailable' };
    },
    current,
    async prefix(observation, after, limit, reader, work) {
      if (!Number.isInteger(limit) || limit < 1 || limit > REALM_SUBJECT_RAW_LIMIT)
        throw new RangeError('Invalid Realm prefix limit');
      const state = await requireCurrent(observation, reader, work);
      const cursor = after === null ? null : frontier(after, observation.revision);
      charge(work);
      admitRows(work, REALM_SUBJECT_RAW_LIMIT);
      const rows = await store.page(
        observation.realm,
        cursor?.key ?? null,
        null,
        REALM_SUBJECT_RAW_LIMIT,
        reader.deadline,
      );
      chargeRows(work, rows.length);
      const subjects: string[] = [];
      let key = cursor?.key ?? null,
        emitted = cursor?.emitted ?? null,
        consumed = 0;
      const context = { reader, work };
      for (const row of rows) {
        // An emitted terminal remains deduplicated even across a sparse raw frontier.
        if (row.terminal !== emitted) {
          const result = await bounded(context, disclosure!.bounds.candidate, () =>
            disclosure!.candidate(row, state.dependency, context),
          );
          if (result === 'unknown' || result === 'withheld') unavailable();
          if (result === 'discussed') {
            subjects.push(row.terminal!);
            emitted = row.terminal;
          }
        }
        key = { terminal: row.terminal!, original: row.original, thread: row.thread };
        consumed++;
        if (subjects.length === limit) break;
      }
      await requireCurrent(observation, reader, work);
      const exhausted = consumed === rows.length && rows.length < REALM_SUBJECT_RAW_LIMIT;
      return {
        subjects,
        after: exhausted
          ? null
          : encode({ revision: observation.revision, key: key!, emitted: emitted === key!.terminal ? emitted : null }),
        exhausted,
      };
    },
    async match(observation, subjects, reader, work) {
      if (subjects.length > REALM_SUBJECT_RAW_LIMIT) throw new RangeError('Invalid Realm membership batch');
      subjects.forEach(realmSubjectRoute);
      const state = await requireCurrent(observation, reader, work);
      const context = { reader, work };
      let remaining = REALM_SUBJECT_RAW_LIMIT;
      const values: RealmSubjectMembership[] = [];
      const cache = new Map<string, RealmSubjectMembership>();
      for (const subject of subjects) {
        const cached = cache.get(subject);
        if (cached) {
          values.push(cached);
          continue;
        }
        const visible = await bounded(context, disclosure!.bounds.subject, () =>
          disclosure!.subject(subject, state.dependency, context),
        );
        let value: RealmSubjectMembership = visible.state === 'readable' ? 'unknown' : visible.state;
        if (visible.state === 'readable' && remaining > 0) {
          const limit = remaining;
          charge(work);
          admitRows(work, limit);
          const rows = await store.page(observation.realm, null, visible.terminal, limit, reader.deadline);
          chargeRows(work, rows.length);
          remaining -= rows.length;
          value = rows.length < limit ? 'not_published' : 'unknown';
          for (const row of rows) {
            const result = await bounded(context, disclosure!.bounds.candidate, () =>
              disclosure!.candidate(row, state.dependency, context),
            );
            if (result === 'discussed') {
              value = result;
              break;
            }
            if (result === 'withheld' || result === 'unknown') value = result;
          }
        }
        cache.set(subject, value);
        values.push(value);
      }
      await requireCurrent(observation, reader, work);
      return values;
    },
  };
}
