import canonicalize from 'canonicalize';
import { createHash } from 'node:crypto';
import type { DiscoveryFilterDocument } from '@rezics/filter';
import type { Pool } from 'pg';
import { ProblemError } from '../http/problem.ts';
import { relationSource } from '../semantic/search-relations.ts';
import { createConceptBrowseStore } from './concept-browse-store.ts';
import { startConceptBrowse, type ConceptDescendantSelection } from './concept-browse.ts';
import {
  CONCEPT_STATEMENT_PREFIX_LIMITS,
  type ConceptFilterExecution,
  type ConceptStatementCut,
  type ConceptStatementReader,
  type ConceptStatementRequest,
} from './concept-browse-statements.ts';
import { discoveryCandidateScanBound } from './discovery-request.ts';
import { SearchUnavailableError } from './opensearch.ts';

type ConceptSelection = Readonly<{ property: string; concept: string; scheme: string }>;

function identity(selection: ConceptSelection): string {
  return JSON.stringify([selection.property, selection.concept, selection.scheme]);
}

function conceptSelections(filter: DiscoveryFilterDocument): ConceptSelection[] {
  const result = new Map<string, ConceptSelection>();
  const pending: DiscoveryFilterDocument[] = [filter];
  while (pending.length) {
    const node = pending.pop()!;
    if ('and' in node || 'or' in node) pending.push(...('and' in node ? node.and : node.or));
    else if ('not' in node) pending.push(node.not);
    else if ('statement' in node && 'in' in node.statement && node.statement.concept) {
      const selection = {
        property: node.statement.property,
        concept: node.statement.in[0]!,
        scheme: node.statement.concept.scheme,
      };
      result.set(identity(selection), selection);
    }
  }
  return [...result.values()];
}

function boundedReservation<T extends Record<string, number>>(maximum: T, name: string) {
  const used = Object.fromEntries(Object.keys(maximum).map((key) => [key, 0])) as Record<keyof T, number>;
  return (cost: T) => {
    for (const key of Object.keys(maximum) as (keyof T)[])
      if ((cost[key] as number) > (maximum[key] as number) - used[key])
        throw new SearchUnavailableError(`${name} exceeded its admitted request reservation`);
    for (const key of Object.keys(maximum) as (keyof T)[]) used[key] += cost[key] as number;
  };
}

function candidateCount(limit: number, countCandidateLimit: number): number {
  return discoveryCandidateScanBound(limit) + countCandidateLimit + 160;
}

function scopeId(selection: ConceptDescendantSelection, binding: ConceptBrowseCut['state']['binding']): string {
  const value = canonicalize({ selection, binding });
  if (value === undefined) throw new TypeError('Concept browse binding is not canonical');
  return createHash('sha256').update(value).digest('hex');
}

type ConceptBrowseCut = ConceptStatementCut;

/**
 * Retain scheme-bound closures in the existing scope-preparation lifecycle before Universal Search
 * evaluates candidates. The same complete cut serves exact and descendant statements; the shared
 * native matcher still decides exactness, qualifiers, Boolean logic and current disclosure.
 */
export async function prepareConceptDiscoveryFilter(
  input: Readonly<{
    pool: Pool;
    prefix: string;
    routeKey: Uint8Array;
    principal: string;
    request: unknown;
    filter: DiscoveryFilterDocument;
    limit: number;
    countCandidateLimit: number;
    now?: () => number;
  }>,
): Promise<ConceptFilterExecution | undefined> {
  const selections = conceptSelections(input.filter);
  if (!selections.length) return undefined;

  const requestValue = canonicalize({ principal: input.principal, request: input.request });
  if (requestValue === undefined) throw new TypeError('Concept request binding is not canonical');
  const requestBinding = createHash('sha256').update(requestValue).digest('hex');
  const maximumCandidates = candidateCount(input.limit, input.countCandidateLimit);
  const maximumWindows = maximumCandidates * CONCEPT_STATEMENT_PREFIX_LIMITS.windows;
  const maximumRows = maximumCandidates * CONCEPT_STATEMENT_PREFIX_LIMITS.rows;
  // Each matched statement page observes the hierarchy before and after its retained membership
  // probes; the final retained-primary cut check does so once more. Statement reads have their
  // separate replay allowance below.
  const maximumObservations = maximumCandidates * (2 * CONCEPT_STATEMENT_PREFIX_LIMITS.windows + 2) * selections.length;
  const reserveNative = boundedReservation(
    {
      keys: maximumObservations,
      rows: 12 * maximumObservations,
      points: 8 * maximumObservations,
      statements: 12 * maximumObservations,
      bytes: 96_000 * maximumObservations,
      emptySeeks: maximumObservations,
    },
    'Concept hierarchy observation',
  );
  // Each matcher attempt admits at most 32 windows and 2048 raw rows per candidate. The
  // native owner replays every admitted window once for currentness, including hidden rows,
  // rejected rows and an empty terminal seek.
  const reserveStatements = boundedReservation(
    { windows: 2 * maximumWindows, rows: 2 * maximumRows },
    'Concept statement prefix',
  );
  const maximumMemberships = maximumCandidates * (CONCEPT_STATEMENT_PREFIX_LIMITS.rows + selections.length);
  const maximumMembershipReads = maximumCandidates * (CONCEPT_STATEMENT_PREFIX_LIMITS.windows + 1) * selections.length;
  const reserveStorage = boundedReservation(
    {
      statements: 6 * selections.length + maximumMemberships + maximumMembershipReads,
      rows: 4 * selections.length + 2 * (maximumMemberships + maximumMembershipReads),
      bytes: 32_768 * (selections.length + maximumMemberships + maximumMembershipReads),
    },
    'Concept retained membership',
  );

  const source = relationSource(input.pool, input.routeKey);
  const cuts = new Map<string, ConceptBrowseCut>();
  for (const selected of selections) {
    const selection: ConceptDescendantSelection = { ...selected, includeChildren: true };
    const browse = source.conceptBrowse(
      selection,
      { principal: input.principal, request: requestBinding },
      reserveNative,
    );
    const observed = await browse.observe();
    if (observed.status !== 'current') {
      if (observed.status === 'preparing')
        throw new ProblemError('index_not_ready', { headers: { 'retry-after': '1' } });
      if (observed.status === 'unavailable') throw new ProblemError('dependency_unavailable');
      throw new ProblemError('invalid_request', { errors: [{ pointer: '/filter', code: 'invalid_format' }] });
    }

    const id = scopeId(selection, observed.binding);
    const store = createConceptBrowseStore(input.pool, input.prefix, id, {
      expiresAt: (input.now ?? Date.now)() + 24 * 60 * 60 * 1000,
      reserve: reserveStorage,
    });
    const state = await startConceptBrowse(selection, observed.binding, store);
    if (!state) throw new SearchUnavailableError('Concept browse definition could not be retained');
    const retained = await store.read(state);
    if (retained.status === 'retired') throw new ProblemError('search_restart_required');
    if (retained.status === 'building') throw new ProblemError('index_not_ready', { headers: { 'retry-after': '1' } });
    cuts.set(identity(selected), { source: browse, store, state });
  }

  const reader: ConceptStatementReader = async (partition, request, after, limit) => {
    reserveStatements({ windows: 2, rows: 2 * limit });
    return source.readConceptStatements(partition, request, after, limit);
  };
  return {
    reader,
    resolveCut(request: ConceptStatementRequest) {
      const key = identity(request.selection);
      return cuts.get(key) ?? null;
    },
  };
}
