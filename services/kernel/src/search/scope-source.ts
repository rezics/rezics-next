import {
  admitFilter,
  FilterError,
  parseFilter,
  positiveFilter,
  type FilterDocument,
  type FilterRelease,
} from '@rezics/filter';
import type { Pool } from 'pg';
import { ProblemError } from '../http/problem.ts';
import { activeRelease } from '../semantic/definitions.ts';
import type { LeafOptions, LeafProgress, LeafWork } from '../semantic/scope-leaf-evidence.ts';
import { packScopeLeafProgress, type ScopeLeafPosition } from './scope-progress.ts';
import { compileFilter } from './filter.ts';
import type { OpenSearch } from './opensearch.ts';
import type { SearchHit } from './query.ts';
import { subjectPartition, type RelationFacetMatch, type SubjectSource } from './source.ts';

/** Independent native work reservation; none of these units are candidate keys. */
export type ScopeNativeBudget = Omit<LeafWork, 'keys'>;

/** One unfinished original/leaf; basis is the composite owner digest, never a native leaf basis. */
export type ScopeEvaluationProgress = Readonly<{
  subject: string;
  basis: string;
}> &
  Pick<NonNullable<ScopeLeafPosition>, 'leafOrdinal'> &
  Omit<LeafProgress, 'basis'>;

export type ScopeEvaluationReservation = Readonly<{
  /** Explicit remaining allowance in the caller's shared raw-key ledger, including alias and prefix work. */
  rawKeys: number;
  native: ScopeNativeBudget;
  progress?: ScopeEvaluationProgress | null;
}>;

export type ScopeBasis = Readonly<{
  release: string;
  query: string;
  profile: string;
  canonical: string;
  generation: number;
  index: string;
}>;

declare const preparedScope: unique symbol;
/** Factory-local opaque state, never an Access or bearer allow claim. */
export type PreparedSearchScope = {
  readonly [preparedScope]: true;
  readonly readiness: 'ready';
  readonly basis: ScopeBasis;
};

export type SearchScopePrefix = {
  hits: readonly SearchHit[];
  basis: ScopeBasis;
  /** Last covered raw key, excluding unused lookahead; null only at the beginning. */
  coveredThrough: string | null;
  exhausted: boolean;
  usage: { candidates: number };
};

export type SearchScopeEvaluation = {
  values: readonly RelationFacetMatch[];
  basis: ScopeBasis;
  usage: { keys: number; native: ScopeNativeBudget };
  /** Native evidence references for final current revalidation, never allow tokens. */
  evidence: readonly string[];
  progress: ScopeEvaluationProgress | null;
};

function unavailable(): never {
  throw new ProblemError('semantic_not_ready', { headers: { 'retry-after': '1' } });
}

function bounded(value: number, maximum: number, minimum = 0): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
    throw new RangeError('Scope reservation is out of range');
}

function nativeBudget(budget: ScopeNativeBudget): void {
  if (!budget || typeof budget !== 'object' || Array.isArray(budget))
    throw new RangeError('Invalid native reservation');
  for (const key of ['points', 'witnesses', 'rows', 'bytes', 'emptySeeks'] as const)
    bounded(budget[key], Number.MAX_SAFE_INTEGER);
}

/** Admission-only scaffold. Native positive execution is deliberately unavailable. */
export function createSearchScopeSource({
  pool,
  release = async () => ((await activeRelease(pool))?.release as FilterRelease | undefined) ?? null,
}: {
  pool: Pool;
  client: OpenSearch;
  prefix: string;
  /** Must be the actual viewer-current source composed by the caller; no account-ID Access substitute. */
  source: SubjectSource;
  release?: () => Promise<FilterRelease | null>;
  /** Actual reader context; absence does not disable independent raw prefix work. */
  evidence?: LeafOptions;
}): {
  prepare(filter: FilterDocument): Promise<PreparedSearchScope>;
  prefix(
    prepared: PreparedSearchScope,
    request: {
      afterSubject: string | null;
      quota: number;
      budget: number;
    },
  ): Promise<SearchScopePrefix>;
  evaluate(
    prepared: PreparedSearchScope,
    subjects: readonly string[],
    reservation: ScopeEvaluationReservation,
  ): Promise<SearchScopeEvaluation>;
} {
  return {
    async prepare(filter) {
      try {
        const parsed = parseFilter(filter);
        const current = await release();
        if (!current) unavailable();
        const admitted = admitFilter(parsed, current);
        if (!positiveFilter(admitted))
          throw new ProblemError('unsupported_query', { errors: [{ pointer: '/filter', code: 'unsupported' }] });
        // Exactly the existing compiler, once after expansion/admission. No separate query language.
        compileFilter(admitted, { prefix: 'f', relationOverflow: true });
      } catch (error) {
        if (error instanceof FilterError)
          throw new ProblemError(error.problem, {
            errors: error.errors.map(({ pointer, code }) => ({ pointer: `/filter${pointer}`, code })),
          });
        throw error;
      }
      // No native canonical capability or shared bounded point evaluator has been wired yet.
      // Do not mint a handle, infer readiness from partition positions, or claim a pinned index.
      unavailable();
    },
    async prefix(_prepared, { afterSubject, quota, budget }) {
      bounded(quota, 100, 1);
      bounded(budget, 256, 1);
      if (quota + 1 > budget) throw new RangeError('Reserve quota plus lookahead before dispatch');
      if (afterSubject !== null) subjectPartition(afterSubject);
      unavailable();
    },
    async evaluate(_prepared, subjects, reservation) {
      if (!reservation || typeof reservation !== 'object' || Array.isArray(reservation))
        throw new RangeError('Invalid evaluation reservation');
      bounded(reservation.rawKeys, 256);
      nativeBudget(reservation.native);
      if (reservation.progress != null) {
        const progress = reservation.progress;
        subjectPartition(progress.subject);
        if (!subjects.includes(progress.subject)) throw new RangeError('Pending subject was not requested');
        if (typeof progress.basis !== 'string' || !/^[0-9a-f]{64}$/.test(progress.basis))
          throw new RangeError('Invalid owner basis');
        // Structural validation only; current plan/basis checks require the future charged native probe.
        packScopeLeafProgress(progress, { valueCounts: Array.from({ length: 32 }, () => 64) });
      }
      // Zero remaining is valid. Never infer a key reservation from IDs or any native axis.
      // Runtime must cap each leaf call at 101 remaining keys and subtract actual usage before the next call.
      for (const subject of subjects) subjectPartition(subject);
      unavailable();
    },
  };
}
