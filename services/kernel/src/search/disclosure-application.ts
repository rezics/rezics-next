import canonicalize from 'canonicalize';
import { createHash } from 'node:crypto';
import type { DiscoveryFilterDocument } from '@rezics/filter';
import {
  CONCEPT_STATEMENT_PREFIX_LIMITS,
  type ConceptFilterExecution,
  type ConceptStatementCut,
  type ConceptStatementReader,
  type ConceptStatementRequest,
} from './concept-browse-statements.ts';
import {
  startConceptBrowse,
  type ConceptDescendantSelection,
  type ConceptBrowseSource,
  type ConceptBrowseStore,
} from './concept-browse.ts';
import type {
  DiscoveryOwnerHit,
  DiscoveryOwnerMetadataSummary,
  DiscoveryReadContext,
  DiscoveryPage,
} from './discovery.ts';
import type { PublicFilterCoveragePage } from './public-filter-coverage-page.ts';
import { SearchOperationError, SearchUnavailableError } from './operation-outcomes.ts';
import { discoveryCandidateScanBound } from './service-request.ts';
import { conceptSelections, type EngineToken } from './disclosure/admission.ts';
import { checkHits } from './disclosure/check.ts';
import { createCurrentTextMatcher, type CurrentTextAnalyzer as Analyzer } from './disclosure/current-text.ts';
import {
  readOwnerCandidates,
  readOwnerBatches,
  projectOwnerHits,
  revalidateOwnerCurrentSummaries,
  type OwnerDisclosurePorts,
  type DiscoveryOwnerCandidate,
} from './disclosure/owner-current.ts';

export type { Hit, FactClause } from './disclosure/admission.ts';
export { checkHits } from './disclosure/check.ts';
export { createCurrentTextMatcher, CURRENT_TEXT_LIMITS } from './disclosure/current-text.ts';
export { ownerSummaryUnchanged, revalidateOwnerCurrentSummaries } from './disclosure/owner-current.ts';

/** Request-scoped analysis is supplied by the installed native adapter, never by HTTP. */
export type SearchDisclosurePorts = Readonly<{
  analyze(index: string, analyzer: Analyzer, text: string): Promise<readonly EngineToken[]>;
}>;

/** Native hierarchy/storage costs retain the existing admitted reservation dimensions. */
export type ConceptDiscoveryPorts = Readonly<{
  browse(
    selection: ConceptDescendantSelection,
    binding: { principal: string; request: string },
    reserve: (cost: {
      keys: number;
      rows: number;
      points: number;
      statements: number;
      bytes: number;
      emptySeeks: number;
    }) => void,
  ): ConceptBrowseSource;
  store(
    id: string,
    options: { expiresAt: number; reserve: (cost: { statements: number; rows: number; bytes: number }) => void },
  ): ConceptBrowseStore;
  readStatements: ConceptStatementReader;
}>;

/** Finite request work is owned here; physical analyzer and native persistence are adapters. */
export function createSearchDisclosureApplication(ports: SearchDisclosurePorts) {
  return {
    checkHits,
    discloseOwnerHits,
    revalidateOwnerCurrentSummaries,
    finishDiscoveryDisclosure,
    prepareConceptFilter: prepareConceptDisclosure,
    currentText: (index: string) => createCurrentTextMatcher((analyzer, text) => ports.analyze(index, analyzer, text)),
  };
}
export type SearchDisclosureApplication = ReturnType<typeof createSearchDisclosureApplication>;

/** Nested context never authorizes a result: re-read every accepted owner before projection. */
export async function discloseOwnerHits(
  ports: OwnerDisclosurePorts,
  candidates: readonly DiscoveryOwnerCandidate[],
  context: DiscoveryReadContext,
): Promise<readonly (DiscoveryOwnerHit | undefined)[]> {
  const accepted = await readOwnerCandidates(ports, candidates, context);
  const reviews = accepted.flatMap((entry) =>
    entry?.kind === 'review' ? [entry.value as DiscoveryOwnerMetadataSummary<'review'>] : [],
  );
  const accounts = await readOwnerBatches(
    reviews.map((row) => row.authorId),
    (ids) => ports.hydrateAccounts(ids, context),
  );
  const subjects = await readOwnerBatches(
    reviews.map((row) => row.subjectId),
    (ids) => ports.hydrateSubjects(ids, context),
  );
  const current = await revalidateOwnerCurrentSummaries(ports, accepted, context);
  return projectOwnerHits(current, accounts, subjects);
}

/** Project every dependent value before the one CURRENT native page final.
 * The native root owns the closed plan, complete child chain and own-row sets;
 * returned hits and diagnostic readStatus are not disclosure authority.
 * Kind counts on the projected page must already be decided from this execution:
 * a disclosed sample never becomes an exact total after FINAL.
 */
export async function finishDiscoveryDisclosure(
  coverage: Pick<PublicFilterCoveragePage, 'finish'>,
  project: () => Promise<DiscoveryPage>,
): Promise<DiscoveryPage> {
  const page = await project();
  await coverage.finish();
  return page;
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
export async function prepareConceptDisclosure(
  input: Readonly<{
    principal: string;
    request: unknown;
    filter: DiscoveryFilterDocument;
    limit: number;
    countCandidateLimit: number;
    now: () => number;
  }>,
  ports: ConceptDiscoveryPorts,
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

  const cuts = new Map<string, ConceptBrowseCut>();
  for (const selected of selections) {
    const selection: ConceptDescendantSelection = { ...selected, includeChildren: true };
    const browse = ports.browse(selection, { principal: input.principal, request: requestBinding }, reserveNative);
    const observed = await browse.observe();
    if (observed.status !== 'current') {
      if (observed.status === 'preparing') throw new SearchOperationError('index_not_ready');
      if (observed.status === 'unavailable') throw new SearchOperationError('dependency_unavailable');
      throw new SearchOperationError('invalid_request', { errors: [{ pointer: '/filter', code: 'invalid_format' }] });
    }

    const id = scopeId(selection, observed.binding);
    const store = ports.store(id, {
      expiresAt: input.now() + 24 * 60 * 60 * 1000,
      reserve: reserveStorage,
    });
    const state = await startConceptBrowse(selection, observed.binding, store);
    if (!state) throw new SearchUnavailableError('Concept browse definition could not be retained');
    const retained = await store.read(state);
    if (retained.status === 'retired') throw new SearchOperationError('search_restart_required');
    if (retained.status === 'building') throw new SearchOperationError('index_not_ready');
    cuts.set(identity(selected), { source: browse, store, state });
  }

  const reader: ConceptStatementReader = async (partition, request, after, limit) => {
    reserveStatements({ windows: 2, rows: 2 * limit });
    return ports.readStatements(partition, request, after, limit);
  };
  return {
    reader,
    resolveCut(request: ConceptStatementRequest) {
      const key = identity(request.selection);
      return cuts.get(key) ?? null;
    },
  };
}

/** Current-evidence refusal applies to the whole page, including negative predicates. */
export async function runSearchSource<T>(
  operation: () => Promise<T>,
  preserveAdapterError: (error: unknown) => boolean,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof SearchOperationError || preserveAdapterError(error)) throw error;
    if (error instanceof SearchUnavailableError) throw new SearchOperationError('index_not_ready');
    throw new SearchOperationError('semantic_not_ready');
  }
}

/** Each installed service retains one template initialization and retries it after a failed attempt. */
export function createSearchIndexRequest(
  ports: Readonly<{
    install(): Promise<void>;
    unavailable(error: unknown): boolean;
  }>,
) {
  let templates: Promise<void> | undefined;
  return async <T>(operation: () => Promise<T>): Promise<T> => {
    try {
      templates ??= ports.install();
      await templates;
      return await operation();
    } catch (error) {
      templates = undefined;
      if (error instanceof SearchUnavailableError || ports.unavailable(error))
        throw new SearchOperationError('index_not_ready');
      throw error;
    }
  };
}
