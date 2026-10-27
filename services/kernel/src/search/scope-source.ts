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
import type { FactClause } from './disclosure/check.ts';
import { compileFilter } from './filter.ts';
import type { OpenSearch } from './opensearch.ts';
import type { SearchHit } from './query.ts';
import { subjectPartition, type RelationFacetMatch, type SubjectSource } from './source.ts';

/** Independent native work reservation; none of these units are candidate keys. */
export type ScopeNativeBudget = Readonly<{
  points: number;
  witnesses: number;
  rows: number;
  bytes: number;
  emptySeeks: number;
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

/** Required native evidence surface, not a production implementation or an identity proof. */
export interface SearchScopeNative {
  /** Fixed-home digest of partition-local structural generations, not ordinary source positions. */
  basis(budget: ScopeNativeBudget): Promise<{
    readiness: 'ready' | 'not_ready';
    canonical: string | null;
    usage: ScopeNativeBudget;
  }>;
  /** Current terminal identity and original/terminal authority; alias windows must be resumable. */
  identity(
    subject: string,
    afterAlias: string | null,
    budget: ScopeNativeBudget,
  ): Promise<{
    terminal: string | null;
    aliases: readonly { subject: string; authority: RelationFacetMatch }[];
    afterAlias: string | null;
    exhausted: boolean;
    terminalAuthority: RelationFacetMatch;
    canonical: string;
    usage: ScopeNativeBudget;
  }>;
  /** Aligned complete current leaf evidence, including truthful absence and qualified relation witnesses. */
  leaves(
    subjects: readonly string[],
    clauses: readonly FactClause[],
    budget: ScopeNativeBudget,
  ): Promise<{
    values: readonly (readonly RelationFacetMatch[])[];
    evidence: readonly string[];
    canonical: string;
    usage: ScopeNativeBudget;
  }>;
}

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
  usage: ScopeNativeBudget;
  /** Native evidence references for final current revalidation, never allow tokens. */
  evidence: readonly string[];
};

function unavailable(): never {
  throw new ProblemError('semantic_not_ready', { headers: { 'retry-after': '1' } });
}

function bounded(value: number, maximum: number, minimum = 0): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
    throw new RangeError('Scope reservation is out of range');
}

function nativeBudget(budget: ScopeNativeBudget): void {
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
  native?: SearchScopeNative;
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
    budget: ScopeNativeBudget,
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
    async evaluate(_prepared, subjects, budget) {
      nativeBudget(budget);
      // Duplicates are charged too; point work does not borrow the raw candidate reservation.
      if (subjects.length > budget.points) throw new RangeError('Reserve every subject point before dispatch');
      for (const subject of subjects) subjectPartition(subject);
      unavailable();
    },
  };
}
