import { createHash } from 'node:crypto';
import type { ResourceQuery } from '../../../../../model/definitions/filter-document-v1.ts';
import { QUERY_COST, QueryRejected } from './compile.ts';

type Position = { datasetId: 'product'; dataEpoch: string; sequence: string };
export interface CompleteSearch {
  resultGrain: 'mainVersion'; complete: true;
  context: 'main-version-default' | { kind: 'realm-local'; id: string };
  population: number; total: number; results: Array<{ work: string; mainVersion: string; [key: string]: unknown }>;
  sourcePosition: Position; indexGeneration: string;
}

export interface ConceptRelation { operator: 'include' | 'exclude'; relation: CompleteSearch }

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** A legacy profile must report a complete, bounded relation before set operations. */
export function completeSearch(value: unknown): CompleteSearch {
  const relation = value as CompleteSearch;
  if (!relation || relation.resultGrain !== 'mainVersion' || relation.complete !== true
    || !Array.isArray(relation.results) || relation.results.length !== relation.total
    || relation.results.length > QUERY_COST.candidateRows || !Number.isSafeInteger(relation.population)
    || relation.population < relation.total || relation.sourcePosition?.datasetId !== 'product'
    || !relation.sourcePosition.dataEpoch || !/^\d+$/.test(relation.sourcePosition.sequence)
    || !relation.indexGeneration || relation.results.some(row => typeof row.work !== 'string'
      || typeof row.mainVersion !== 'string')) {
    throw new QueryRejected('query_budget_exceeded', 'Search did not return a complete bounded relation');
  }
  return relation;
}

/** Set operations run on the complete mainVersion grain, before final paging. */
export function combineConcepts(base: CompleteSearch, conditions: readonly ConceptRelation[]) {
  if (conditions.length < 1 || conditions.length > QUERY_COST.conceptReads) {
    throw new QueryRejected('query_budget_exceeded', 'Concept set exceeds its template bound');
  }
  const sets = conditions.map(({ operator, relation }) => {
    if (!same(relation.sourcePosition, base.sourcePosition)
      || relation.indexGeneration !== base.indexGeneration || !same(relation.context, base.context)
      || relation.population !== base.population) {
      throw new QueryRejected('stale_query_result', 'Search selection changed between Concept reads');
    }
    return { operator, members: new Set(relation.results.map(row => row.mainVersion)) };
  });
  return base.results.filter(row => sets.every(({ operator, members }) =>
    operator === 'include' ? members.has(row.mainVersion) : !members.has(row.mainVersion)));
}

interface QueryCursor {
  queryDigest: string; resultDigest: string; sourcePosition: Position; indexGeneration: string;
  presentationDigest: string; nextOffset: number; expiresAt: number;
}

/** A continuation binds the exact Filter and all visible selection generations. */
export function pageConcepts(query: ResourceQuery, base: CompleteSearch,
  selected: CompleteSearch['results'], senses: readonly string[], presentationDigest: string,
  now = Date.now()) {
  const queryDigest = digest([{ ...query, page: { size: query.page.size } }, senses]);
  const resultDigest = digest(selected);
  const prior = query.page.continuation as QueryCursor | undefined;
  if (prior && (typeof prior !== 'object' || !/^[0-9a-f]{64}$/.test(prior.queryDigest)
    || !/^[0-9a-f]{64}$/.test(prior.resultDigest) || !/^[0-9a-f]{64}$/.test(prior.presentationDigest)
    || !Number.isSafeInteger(prior.nextOffset) || prior.nextOffset < 1 || prior.nextOffset >= selected.length
    || !Number.isSafeInteger(prior.expiresAt))) {
    throw new QueryRejected('invalid_query', 'Concept continuation is malformed');
  }
  if (prior && (prior.expiresAt <= now || prior.queryDigest !== queryDigest
    || prior.resultDigest !== resultDigest || prior.presentationDigest !== presentationDigest
    || !same(prior.sourcePosition, base.sourcePosition) || prior.indexGeneration !== base.indexGeneration)) {
    throw new QueryRejected('stale_query_result', 'Concept selection changed; restart at page one');
  }
  const offset = prior?.nextOffset ?? 0;
  const end = Math.min(offset + query.page.size, selected.length);
  const next: QueryCursor | null = end < selected.length ? { queryDigest, resultDigest,
    sourcePosition: base.sourcePosition, indexGeneration: base.indexGeneration, presentationDigest,
    nextOffset: end, expiresAt: prior?.expiresAt ?? now + 5 * 60_000 } : null;
  const page = { profile: 'public-concept-set-phrase-v1' as const,
    resultGrain: 'mainVersion' as const, context: base.context, complete: true as const,
    population: base.population, total: selected.length, sourcePosition: base.sourcePosition,
    indexGeneration: base.indexGeneration, results: selected.slice(offset, end), next };
  if (Buffer.byteLength(JSON.stringify(page)) > QUERY_COST.responseBytes) {
    throw new QueryRejected('query_budget_exceeded', 'Concept page exceeds its byte bound');
  }
  return page;
}
