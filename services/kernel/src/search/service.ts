import {
  admitFilter,
  admitDiscoveryFilter,
  admittedReleaseSearchTypes,
  FilterError,
  parseDiscoveryFilter,
  parseFilter,
  positiveDiscoveryFilter,
  positiveFilter,
  relationFacetProperty,
  type DiscoveryFilterDocument,
  type FilterDocument,
  type FilterRelease,
  type SpoilerThreshold,
} from '@rezics/filter';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Pool } from 'pg';
import { systemClock, type KernelClock } from '../clock.ts';
import { GLOBAL_CONTEXT } from '../access/gates/catalogue.ts';
import { STANDARD_QUESTION_ID } from '../rating/votes.ts';
import { ProblemError, type FieldErrorCode } from '../http/problem.ts';
import { compileKinds, kindDigest, retainCurrent, type KindSnapshot } from './query.ts';
import { activeRelease } from '../semantic/definitions.ts';
import type { KeyRing } from '../tokens/seal.ts';
import type { FacetDiscoveryScope } from './facet-discovery-contract.ts';
import {
  decodeSearchCursor,
  encodeSearchCursor,
  encodeRetainedSearchCursor,
  retainedSearchContinuation,
  type SearchCursorBinding,
  type SearchSortValue,
} from './cursor.ts';
import { REQUEST_SOURCE_KEYS, validateRequestSourceSnapshot } from './request-source-snapshot.ts';
import { checkHits, type FactClause } from './disclosure/check.ts';
import { admitFacets, validateFacets, type FacetRequest } from './facets.ts';
import { compileFilter } from './filter.ts';
import { holdsCurrentText } from './current-leaf.ts';
import { createFreshness } from './freshness.ts';
import {
  admitProperties,
  projectFacts,
  projectHit,
  validateHitOptions,
  validateSearchLimit,
  type SearchHit,
} from './hits.ts';
export { validateSearchLimit } from './hits.ts';
import {
  discoveryIndexUuid,
  readSubjectCalendarFormat,
  readSubjectSortFormat,
  SUBJECT_SORT_FORMAT,
  subjectGenerations,
  subjectIndexName,
} from './indices.ts';
import { OpenSearchError, SearchUnavailableError, type OpenSearch } from './opensearch.ts';
import { publicHitFigures } from './public-figures.ts';
import { installTemplates, searchSubjectHits, suggestSubjects, type SearchPlan } from './query.ts';
import { decodeRatingCursor, encodeRatingCursor, type RatingPhase } from './rating-cursor.ts';
import { normalizePublicRatingFigure, type PublicRatingEpoch, type PublicRatingSource } from './rating-source.ts';
import { subjectConsumer } from './runner.ts';
import { registerSearchScopeRuntime, createSearchScopeForService } from './service-scope.ts';
import { readScopedFacetDiscovery } from './scoped-facet-admission.ts';
import { serviceScopeFacetAdmission } from './scoped-facet-source.ts';
import type { RealmSubjectSource } from '../content/realm-subject-source.ts';
import type { RealmSubjectCapabilities } from './realm-scope.ts';
import type { LeafOptions } from '../semantic/scope-leaf-evidence.ts';
import { ScopeWork, scopeAllowance } from './scope-execution.ts';
import type { ScopeBasis } from './scope-source.ts';
import {
  subjectPartition,
  type IndexedSubject,
  type RelationFacetProbe,
  type RetainedRelationFacetPage,
  type SubjectSource,
} from './source.ts';
import { compileText, parseText, positiveText, TextSyntaxError } from './text.ts';
import { collectUsefulPage } from './useful-page.ts';
import { readPublicSearchPage, type DefaultPublicFilterRuntime } from './public-runtime.ts';
import type {
  PublicFilterConsumerJob,
  PublicFilterConsumerOperations,
  PublicFilterConsumerCapture,
} from './public-filter-consumer-contract.ts';
import type { SearchHit as NativeSearchHit } from './query.ts';
import type { PublicSearchHit } from './public-figures.ts';
import type { KindValue } from './query.ts';
import { deadlineFor } from '../request/deadline.ts';
import {
  admitFacetPage,
  authenticateFacetCursors,
  readFacetDiscovery,
  validateFacetCursorRelease,
} from './facet-discovery-runtime.ts';
import type { FacetDiscoveryProvider } from './facet-discovery-native.ts';
import type { FacetDiscovery200Response } from './facet-discovery-contract.ts';
import { ownSubjectRequest } from './service-request.ts';
import { readRealmRatingOrder, type RealmRatingSource, type RealmRatingQuery } from './realm-rating-order.ts';
import { routeOf } from '../route/route.ts';
import { executeScopedSuggestions } from './scoped-suggestion.ts';
import {
  createReleaseSearchCandidateStreams,
  observeReleaseSearchCandidates,
  type ReleaseSearchCandidatePool,
  type ReleaseSearchCandidateReservation,
} from './release-search-native-stream.ts';
import {
  releaseWorkLink,
  ReleaseGroupingRestartRequired,
  ReleaseGroupingUnavailable,
  type ReleaseGroupingBasis,
  type ReleaseGroupingRequest,
  type ReleaseGroupingSource,
} from './release-search-grouping.ts';
import {
  readReleaseChildrenPage,
  readReleaseGroupsPage,
  type ReleaseSearchGroup as PublicReleaseSearchGroup,
  type ReleaseSearchPrincipal,
} from './release-search-cursor.ts';
import { createReleaseSearchGroupingSource } from './release-search-source.ts';
import type { SubjectCanonicalNames } from '../semantic/subject-source-key-pages.ts';

export type SearchRequest = {
  text?: string;
  filter?: unknown;
  sort?: SearchPlan['sort'];
  spoilerThreshold?: number;
  population?: { realm: string };
  limit?: number;
  cursor?: string;
  kindCursor?: string;
  descriptions?: boolean;
  languages?: string[];
  properties?: string[];
};

export type ReleaseGroupedSearchRequest = {
  operation?: 'groups' | 'children';
  work?: string;
  text?: string;
  filter?: unknown;
  sort?: 'name' | 'relevance';
  spoilerThreshold?: number;
  cursor?: string;
  descriptions?: boolean;
  languages?: string[];
  properties?: string[];
};

export type ReleaseGroupedSearchPage =
  | {
      operation: 'groups';
      status: 'ready' | 'preparing';
      groups: PublicReleaseSearchGroup<PublicSearchHit, PublicSearchHit>[];
      next: string | null;
      as_of: string;
    }
  | {
      operation: 'children';
      status: 'ready' | 'preparing';
      children: PublicSearchHit[];
      next: string | null;
      as_of: string;
    };

type SearchFilterDocument = FilterDocument | DiscoveryFilterDocument;

export type PublicSearchPage = {
  subjects: PublicSearchHit[];
  kinds?: { values: KindValue[]; next: string | null };
  next: string | null;
  as_of: string;
};

export type PublicSearchReadContext = Readonly<{
  deadline: number;
  /** The verified request context used only by the service-bound native Scope. */
  scope?: LeafOptions;
  realmAuthority?: RealmRatingQuery['authority'];
  complete: (page: PublicSearchPage) => Promise<void>;
}>;

type Result = { id: string; type: string; labels: Record<string, string> };

function invalid(pointer: string, code: FieldErrorCode): never {
  throw new ProblemError('invalid_request', { errors: [{ pointer, code }] });
}

function unsupported(pointer: string, code: FieldErrorCode = 'unsupported'): never {
  throw new ProblemError('unsupported_query', { errors: [{ pointer, code }] });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function containsCalendarRange(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsCalendarRange);
  if (!isRecord(value)) return false;
  if (isRecord(value.statement) && isRecord(value.statement.range) && value.statement.range.type === 'time')
    return true;
  return Object.values(value).some(containsCalendarRange);
}

/** Remove the one top-level request scope leaf; the admitted native Scope carries its membership. */
function scopedCatalogueCondition(value: unknown, scope: FacetDiscoveryScope): unknown {
  if (value === undefined || value === '') return undefined;
  let document = value;
  if (typeof value === 'string') {
    try {
      document = JSON.parse(value);
    } catch {
      invalid('/conditions', 'invalid_format');
    }
  }
  const leaves: { kind: string; leaf: Record<string, unknown>; operand: unknown }[] = [];
  const visit = (node: unknown) => {
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    if (!isRecord(node)) return;
    for (const kind of ['realm', 'collection'])
      if (Object.hasOwn(node, kind)) leaves.push({ kind, leaf: node, operand: node[kind] });
    for (const [key, child] of Object.entries(node)) if (key !== 'realm' && key !== 'collection') visit(child);
  };
  visit(document);
  if (!leaves.length) return document;
  const candidate = leaves[0]!;
  const topLevel =
    document === candidate.leaf ||
    (isRecord(document) &&
      Object.keys(document).length === 1 &&
      Array.isArray(document.and) &&
      document.and.includes(candidate.leaf));
  if (
    leaves.length !== 1 ||
    !topLevel ||
    candidate.kind !== scope.kind ||
    Object.keys(candidate.leaf).length !== 1 ||
    !isRecord(candidate.operand) ||
    Object.keys(candidate.operand).length !== 1 ||
    !Object.hasOwn(candidate.operand, 'id') ||
    typeof candidate.operand.id !== 'string' ||
    candidate.operand.id.toLowerCase() !== scope.id.toLowerCase()
  )
    invalid('/conditions', 'invalid_format');
  if (document === candidate.leaf) return undefined;
  const remaining = (document as { and: unknown[] }).and.filter((entry) => entry !== candidate.leaf);
  if (!remaining.length) return undefined;
  return remaining.length === 1 ? remaining[0] : { and: remaining };
}

function indexNotReady(): ProblemError {
  return new ProblemError('index_not_ready', { headers: { 'retry-after': '1' } });
}

/** Unavailable current evidence must fail the response, including under negation. */
async function sourceRequest<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof ProblemError) throw error;
    if (error instanceof SearchUnavailableError) throw indexNotReady();
    throw new ProblemError('semantic_not_ready', { headers: { 'retry-after': '1' } });
  }
}

function containsOwnerPredicate(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const node = value as Record<string, unknown>;
  if (Object.hasOwn(node, 'owner')) return true;
  if ('not' in node && containsOwnerPredicate(node.not)) return true;
  return ['and', 'or'].some((key) => Array.isArray(node[key]) && node[key].some(containsOwnerPredicate));
}

function containsRealmPredicate(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const node = value as Record<string, unknown>;
  if (Object.hasOwn(node, 'realm')) return true;
  if ('not' in node && containsRealmPredicate(node.not)) return true;
  return ['and', 'or'].some((key) => Array.isArray(node[key]) && node[key].some(containsRealmPredicate));
}

function containsUnsupportedDiscoveryLeaf(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const node = value as Record<string, unknown>;
  if (Object.hasOwn(node, 'kind') || Object.hasOwn(node, 'ratingQuestion')) return true;
  if ('not' in node && containsUnsupportedDiscoveryLeaf(node.not)) return true;
  return ['and', 'or'].some((key) => Array.isArray(node[key]) && node[key].some(containsUnsupportedDiscoveryLeaf));
}

function scopeEvaluationReservation(work: ScopeWork, rawKeys: number) {
  const allowance = work.remaining();
  const remaining = allowance.remaining;
  return {
    rawKeys,
    native: {
      points: remaining.nativePoints,
      witnesses: remaining.witnessKeys,
      rows: remaining.nativeRows,
      bytes: remaining.bytes,
      emptySeeks: remaining.emptySeeks,
    },
    allowance,
  };
}

export function bindSearchScopeCursorRequest(request: unknown, basis: ScopeBasis): unknown {
  const record =
    request !== null && typeof request === 'object' && !Array.isArray(request)
      ? (request as Record<string, unknown>)
      : { request };
  return {
    ...record,
    scopeBasis: {
      release: basis.release,
      query: basis.query,
      profile: basis.profile,
      canonical: basis.canonical,
      generation: 'generation' in basis ? basis.generation : null,
      index: 'index' in basis ? basis.index : null,
    },
  };
}

function scopeCursorAfter(sort: 'id', after: readonly (string | number | null)[]): string;
function scopeCursorAfter(sort: 'name', after: readonly (string | number | null)[]): readonly [string | null, string];
function scopeCursorAfter(
  sort: 'collections',
  after: readonly (string | number | null)[],
): readonly [number, string | null, string];
function scopeCursorAfter(
  sort: 'id' | 'name' | 'collections',
  after: readonly (string | number | null)[],
): string | readonly [string | null, string] | readonly [number, string | null, string] {
  if (sort === 'id') {
    if (after.length !== 1 || typeof after[0] !== 'string') throw new ProblemError('search_restart_required');
    return after[0];
  }
  if (sort === 'name') {
    if (after.length !== 2 || !(after[0] === null || typeof after[0] === 'string') || typeof after[1] !== 'string')
      throw new ProblemError('search_restart_required');
    return [after[0], after[1]] as const;
  }
  if (
    after.length !== 3 ||
    typeof after[0] !== 'number' ||
    !(after[1] === null || typeof after[1] === 'string') ||
    typeof after[2] !== 'string'
  )
    throw new ProblemError('search_restart_required');
  return [after[0], after[1], after[2]] as const;
}

function project(subject: IndexedSubject, languages?: readonly string[]): Result {
  const hit = projectHit(subject, { descriptions: false, ...(languages === undefined ? {} : { languages }) });
  return {
    id: hit.id,
    type: hit.type,
    labels: hit.labels,
  };
}

// OpenSearch may wrap a missing script in a search phase error with root causes.
function missingTemplate(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false;
  const details = error as { reason?: unknown; caused_by?: unknown; root_cause?: unknown };
  if (
    typeof details.reason === 'string' &&
    (/unable to find script \[/.test(details.reason) ||
      (/stored script|stored template/.test(details.reason) && /does not exist|not found|missing/.test(details.reason)))
  )
    return true;
  return (
    missingTemplate(details.caused_by) ||
    (Array.isArray(details.root_cause) && details.root_cause.some(missingTemplate))
  );
}

function validate(request: SearchRequest) {
  let text;
  try {
    if (request.text !== undefined) {
      if (typeof request.text !== 'string') invalid('/text', 'invalid_type');
      text = parseText(request.text);
    }
  } catch (error) {
    if (error instanceof TextSyntaxError) unsupported('/text', error.code);
    throw error;
  }

  let filter: SearchFilterDocument | undefined;
  try {
    if (request.filter !== undefined) {
      const discovery = parseDiscoveryFilter(request.filter);
      filter = containsRealmPredicate(discovery) ? discovery : parseFilter(request.filter);
    }
  } catch (error) {
    if (error instanceof FilterError)
      throw new ProblemError(error.problem, {
        errors: error.errors.map(({ pointer, code }) => ({ pointer: `/filter${pointer}`, code })),
      });
    throw error;
  }

  const realmFilter = filter !== undefined && containsRealmPredicate(filter);
  const sort = request.sort === undefined ? (realmFilter ? 'name' : text ? 'relevance' : 'name') : request.sort;
  if (sort !== 'relevance' && sort !== 'name' && sort !== 'id' && sort !== 'collections' && sort !== 'rating')
    invalid('/sort', 'invalid_format');
  if (sort === 'relevance' && !text) unsupported('/sort');
  let spoilerThreshold: SpoilerThreshold | undefined;
  if (request.spoilerThreshold !== undefined) {
    const value = request.spoilerThreshold;
    if (!Number.isSafeInteger(value) || value < 0 || value > 2) invalid('/spoilerThreshold', 'invalid_format');
    spoilerThreshold = value as SpoilerThreshold;
  }
  if (spoilerThreshold !== undefined && !filter) unsupported('/spoilerThreshold');
  if (realmFilter && sort !== 'name') unsupported('/sort');
  if (request.population !== undefined) {
    const population = request.population;
    if (
      !population ||
      typeof population !== 'object' ||
      Array.isArray(population) ||
      Object.keys(population).length !== 1 ||
      typeof population.realm !== 'string' ||
      routeOf(population.realm) === null ||
      population.realm === GLOBAL_CONTEXT.id
    )
      invalid('/population', 'invalid_format');
    if (sort !== 'rating') unsupported('/population');
  }
  const limit = validateSearchLimit(request.limit);
  const hitOptions = validateHitOptions(request);

  return {
    text,
    filter,
    sort,
    spoilerThreshold,
    limit,
    hitOptions,
    // Keep the validated JSON, rather than the compiler's internal representation, in the binding.
    bindingRequest: {
      ...(text ? { text: request.text } : {}),
      ...(filter ? { filter } : {}),
      sort,
      ...(spoilerThreshold !== undefined ? { spoilerThreshold } : {}),
      ...(request.population ? { population: request.population } : {}),
      limit,
      ...(hitOptions.descriptions ? { descriptions: true } : {}),
      ...(hitOptions.languages ? { languages: hitOptions.languages } : {}),
      ...(hitOptions.properties ? { properties: hitOptions.properties } : {}),
    },
  };
}

/** Classify the same bounded parser trees used by execution; never infer syntax from raw text. */
export function requiresAdvancedSearch(request: SearchRequest): boolean {
  const { text, filter, sort } = validate(request);
  const basicText = (node: NonNullable<typeof text>): boolean =>
    node.kind === 'term' ||
    node.kind === 'phrase' ||
    ((node.kind === 'and' || node.kind === 'or') && node.children.every(basicText));
  const basicFilter = (node: NonNullable<typeof filter>): boolean =>
    'type' in node || ('and' in node && node.and.every(basicFilter)) || ('or' in node && node.or.every(basicFilter));
  return (
    sort === 'rating' ||
    sort === 'collections' ||
    (text !== undefined && !basicText(text)) ||
    (filter !== undefined && !basicFilter(filter))
  );
}

export function createSearchService({
  pool,
  client,
  prefix,
  source,
  ratings,
  realmSubjects,
  realmRatings,
  realmSubjectCapabilities,
  cursors,
  clock = systemClock,
  facetSample = 10_000,
  facetProvider,
  publicFilters,
  preparePublic,
  releaseSearchPools: configuredReleaseSearchPools,
  // Definition releases store value.pattern on the property schema. Keep that object so pattern compilation stays cached.
  release: releaseOverride,
}: {
  pool: Pool;
  client: OpenSearch;
  prefix: string;
  source: SubjectSource;
  ratings?: PublicRatingSource;
  realmSubjects?: RealmSubjectSource;
  realmRatings?: RealmRatingSource;
  realmSubjectCapabilities?: RealmSubjectCapabilities;
  cursors: KeyRing;
  clock?: KernelClock;
  release?: () => Promise<FilterRelease | null>;
  /** Legacy preview helper tuning; never used by the public continuation path. */
  facetSample?: number;
  /** Trusted native provider; omitted only by historical isolated service fixtures. */
  publicFilters?: () => DefaultPublicFilterRuntime;
  preparePublic?: (job: PublicFilterConsumerJob) => Promise<void>;
  /** Trusted native owner composition. Missing native ports fail closed. */
  facetProvider?: () => Promise<FacetDiscoveryProvider | undefined>;
  /** All native source pools participating in Global release ownership and current disclosure. */
  releaseSearchPools?: readonly (ReleaseSearchCandidatePool & { source: SubjectSource })[];
}) {
  const release =
    releaseOverride ?? (async () => ((await activeRelease(pool))?.release as FilterRelease | undefined) ?? null);
  const realmRelease = releaseOverride
    ? async (expected?: string) => {
        const current = await releaseOverride();
        if (!current) return null;
        const digest = kindDigest(current);
        return expected !== undefined && expected !== digest ? null : { digest, release: current };
      }
    : undefined;
  if (!Number.isSafeInteger(facetSample) || facetSample < 1)
    throw new RangeError('facetSample must be a positive safe integer');
  let templates: Promise<void> | undefined;
  let aliasRead: Promise<number> | undefined;
  const freshness = new Map<number, ReturnType<typeof createFreshness>>();

  async function indexRequest<T>(operation: () => Promise<T>): Promise<T> {
    try {
      templates ??= installTemplates(client, prefix);
      await templates;
      return await operation();
    } catch (error) {
      templates = undefined;
      if (error instanceof SearchUnavailableError) throw indexNotReady();
      if (error instanceof OpenSearchError) {
        const body = error.body as { error?: unknown } | null;
        if (error.type === 'index_not_found_exception' || missingTemplate(body?.error)) throw indexNotReady();
      }
      throw error;
    }
  }

  async function freshAliasGeneration(): Promise<number> {
    const { active } = await subjectGenerations(client, prefix);
    if (active === null) throw indexNotReady();
    return active;
  }

  function aliasGeneration(): Promise<number> {
    if (aliasRead) return aliasRead;
    const read = freshAliasGeneration().finally(() => {
      if (aliasRead === read) aliasRead = undefined;
    });
    aliasRead = read;
    return read;
  }

  async function ratingEpoch(): Promise<PublicRatingEpoch> {
    try {
      if (!ratings) throw indexNotReady();
      const value = await ratings.epoch();
      if (
        !value ||
        typeof value !== 'object' ||
        value.questionId !== STANDARD_QUESTION_ID ||
        value.populationId !== GLOBAL_CONTEXT.id ||
        !(value.priorEpoch === null || (Number.isSafeInteger(value.priorEpoch) && value.priorEpoch > 0))
      )
        throw indexNotReady();
      return { questionId: value.questionId, populationId: value.populationId, priorEpoch: value.priorEpoch };
    } catch {
      throw indexNotReady();
    }
  }

  async function ratingCandidates(
    hits: Awaited<ReturnType<typeof searchSubjectHits>>['hits'],
    rating: PublicRatingEpoch,
    positions: ReadonlyMap<number, bigint>,
  ) {
    // Disclosure returns these same candidate objects through its smaller Hit interface.
    const accepted = new Set<object>();
    const partitions = new Map<number, string[]>();
    for (const hit of hits) partitions.set(hit.partition, [...(partitions.get(hit.partition) ?? []), hit.id]);
    for (const [partition, ids] of partitions) {
      let snapshot;
      try {
        snapshot = await ratings!.read(partition, [...new Set(ids)]);
        if (
          snapshot.partition !== partition ||
          typeof snapshot.position !== 'bigint' ||
          snapshot.position < 0n ||
          snapshot.position !== positions.get(partition) ||
          !(snapshot.figures instanceof Map) ||
          [...snapshot.figures.keys()].some((id) => !ids.includes(id))
        )
          throw indexNotReady();
      } catch {
        throw indexNotReady();
      }
      for (const hit of hits.filter((hit) => hit.partition === partition)) {
        const raw = snapshot.figures.get(hit.id);
        let figure;
        if (snapshot.figures.has(hit.id)) {
          try {
            figure = normalizePublicRatingFigure(raw, {
              questionId: rating.questionId,
              populationId: rating.populationId,
              subjectId: hit.id,
            });
          } catch {
            // A stale or unproven candidate is consumed, never reranked into the other phase.
            continue;
          }
        }
        const eligible =
          rating.priorEpoch !== null && figure?.priorEpoch === rating.priorEpoch && figure.score !== null;
        if (
          hit.ratingPhase === 'scored'
            ? eligible && figure!.score === hit.sort[0]
            : hit.ratingPhase === 'unscored' && !eligible
        )
          accepted.add(hit);
      }
    }
    return accepted;
  }

  async function discoveryGeneration(): Promise<number> {
    const generation = await indexRequest(aliasGeneration);
    const format = await indexRequest(() => readSubjectSortFormat(client, prefix, generation));
    if (format !== SUBJECT_SORT_FORMAT) throw indexNotReady();
    return generation;
  }

  async function asOf(generation: number): Promise<string> {
    const reader = retainCurrent(freshness, generation, () =>
      createFreshness(pool, subjectConsumer(prefix, generation)),
    );
    const observed = await reader.current();
    if (publicFilters && observed.behind > 0 && Date.now() - observed.asOf.getTime() > 300_000) throw indexNotReady();
    return observed.asOf.toISOString();
  }

  async function admitQuery(
    text: ReturnType<typeof parseText> | undefined,
    filter: SearchFilterDocument | undefined,
    current?: FilterRelease,
    nativeOrder = false,
    spoilerThreshold?: SpoilerThreshold,
    inverse = false,
  ) {
    let admitted;
    if (filter) {
      const active = current ?? (await release());
      if (!active) throw new ProblemError('semantic_not_ready', { headers: { 'retry-after': '1' } });
      try {
        if (containsRealmPredicate(filter)) {
          if (containsUnsupportedDiscoveryLeaf(filter)) unsupported('/filter');
          admitted = admitDiscoveryFilter(parseDiscoveryFilter(filter), active, new Set(), {
            owner: true,
            ...(spoilerThreshold !== undefined ? { spoilerThreshold } : {}),
          });
        } else {
          admitted = admitFilter(filter as FilterDocument, active, {
            ...(containsOwnerPredicate(filter) ? { owner: true as const } : inverse ? { inverse: true as const } : {}),
            ...(spoilerThreshold !== undefined ? { spoilerThreshold } : {}),
          });
        }
      } catch (error) {
        if (error instanceof FilterError)
          throw new ProblemError(error.problem, {
            errors: error.errors.map(({ pointer, code }) => ({ pointer: `/filter${pointer}`, code })),
          });
        throw error;
      }
    }
    if (
      !publicFilters &&
      !nativeOrder &&
      (text || admitted) &&
      !(text && positiveText(text)) &&
      !(
        admitted &&
        (containsRealmPredicate(admitted)
          ? positiveDiscoveryFilter(admitted as DiscoveryFilterDocument)
          : positiveFilter(admitted as FilterDocument))
      )
    )
      unsupported(text ? '/text' : '/filter');
    return admitted;
  }

  async function currentReleaseSnapshot() {
    if (releaseOverride) {
      const current = await releaseOverride();
      return current ? { digest: kindDigest(current), head: 0, release: current } : null;
    }
    const current = await activeRelease(pool);
    return current
      ? { digest: current.digest, head: current.head ?? 0, release: current.release as FilterRelease }
      : null;
  }

  async function groupedReleaseSearch(
    principal: ReleaseSearchPrincipal,
    submitted: ReleaseGroupedSearchRequest,
    now = clock().getTime(),
    context: { deadline: number } = { deadline: deadlineFor(30_000) },
  ): Promise<ReleaseGroupedSearchPage> {
    submitted = ownSubjectRequest(submitted);
    const operation = submitted.operation ?? 'groups';
    if (operation !== 'groups' && operation !== 'children') invalid('/operation', 'invalid_format');
    if (operation === 'children') {
      try {
        if (!submitted.work) throw new Error('missing work');
        subjectPartition(submitted.work);
      } catch {
        invalid('/work', 'invalid_format');
      }
    } else if (submitted.work !== undefined) invalid('/work', 'unsupported');
    if (submitted.cursor !== undefined &&
      (typeof submitted.cursor !== 'string' || !submitted.cursor || submitted.cursor.length > 4864))
      invalid('/cursor', 'invalid_format');

    const normalized = validate({
      ...(submitted.text === undefined ? {} : { text: submitted.text }),
      ...(submitted.filter === undefined ? {} : { filter: submitted.filter }),
      ...(submitted.sort === undefined ? {} : { sort: submitted.sort }),
      spoilerThreshold: submitted.spoilerThreshold ?? 0,
      descriptions: submitted.descriptions ?? true,
      ...(submitted.languages === undefined ? {} : { languages: submitted.languages }),
      ...(submitted.properties === undefined ? {} : { properties: submitted.properties }),
      limit: 20,
    });
    if (normalized.sort !== 'name') unsupported('/sort');
    const active = await currentReleaseSnapshot();
    if (!active) throw new ProblemError('semantic_not_ready', { headers: { 'retry-after': '1' } });
    const admitted = await admitQuery(
      normalized.text,
      normalized.filter,
      active.release,
      false,
      normalized.spoilerThreshold,
      true,
    );
    if (!admitted || containsRealmPredicate(admitted)) unsupported('/filter');
    const filter = admitted as FilterDocument;
    const options = normalized.hitOptions;
    if (options.properties) admitProperties(options.properties, active.release);
    const generation = await discoveryGeneration();
    const calendarFormat = await indexRequest(() => readSubjectCalendarFormat(client, prefix, generation));
    if (containsCalendarRange(filter) && calendarFormat === null) throw indexNotReady();
    const compiled = compileFilter(filter, {
      prefix: 'release',
      relationOverflow: true,
      ...(calendarFormat === null ? {} : { calendarFormat }),
    });
    const clauses = new Map<string, FactClause>(compiled.leaves.map((leaf) => [leaf.name, leaf]));
    const relationProperties = [
      ...new Set(
        compiled.leaves.flatMap((leaf) =>
          leaf.facet === 'statement' && relationFacetProperty(active.release, leaf.property) ? [leaf.property] : [],
        ),
      ),
    ];
    const request: ReleaseGroupingRequest = {
      releaseDigest: active.digest,
      filter,
      ...(submitted.text === undefined ? {} : { text: submitted.text }),
      sort: normalized.sort,
      languages: options.languages ?? [],
      spoilerThreshold: (normalized.spoilerThreshold ?? 0) as SpoilerThreshold,
      groupLimit: 20,
      childLimit: 20,
      previewLimit: 3,
    };

    const indexedSource = source as SubjectSource & { canonicalNames?: SubjectCanonicalNames };
    const pools = configuredReleaseSearchPools?.length
      ? [...configuredReleaseSearchPools]
      : indexedSource.canonicalNames
        ? [{ id: 'global', names: indexedSource.canonicalNames, source }]
        : [];
    if (!pools.length || pools.some(({ source: native }) => !native.readCompleteWorkLinks)) throw indexNotReady();

    const totals = {
      observations: 0,
      ownerReads: 0,
      nameSeeks: 0,
      keys: 0,
      sourceReads: 0,
      completeWorkLinkReads: 0,
      authorityObservations: 0,
      relationFacetReads: 0,
      hydrationReads: 0,
      serializationBytes: 0,
    };
    const reserve = (value: ReleaseSearchCandidateReservation) => {
      if (Date.now() > context.deadline) throw new ProblemError('deadline_exceeded');
      for (const key of Object.keys(totals) as (keyof typeof totals)[]) {
        const amount = value[key] ?? 0;
        if (!Number.isSafeInteger(amount) || amount < 0 || totals[key] + amount > 100_000_000)
          throw new ReleaseGroupingUnavailable();
      }
      for (const key of Object.keys(totals) as (keyof typeof totals)[]) totals[key] += value[key] ?? 0;
    };
    const liveRelease = async () => {
      return currentReleaseSnapshot();
    };
    const poolSources = new Map(pools.map((candidate) => [candidate.id, candidate.source as SubjectSource]));
    const nativeContext = {
      deadline: context.deadline,
      reserve,
      async observe({ deadline, homesByPool }: {
        deadline: number;
        homesByPool: Readonly<Record<string, readonly { partition: number; position: string }[]>>;
      }): Promise<ReleaseGroupingBasis> {
        if (Date.now() > deadline) throw new ProblemError('deadline_exceeded');
        const current = await liveRelease();
        if (!current) throw indexNotReady();
        const currentGeneration = await discoveryGeneration();
        const indexUuid = await indexRequest(() => discoveryIndexUuid(client, prefix, currentGeneration));
        const physical = {
          generation: currentGeneration,
          incarnation: `${currentGeneration}:${current.head}`,
          indexUuid,
        };
        const ready = await indexRequest(() => readSubjectCalendarFormat(client, prefix, currentGeneration));
        const positions: (string | number)[][] = [];
        for (const poolId of Object.keys(homesByPool).sort()) {
          const native = poolSources.get(poolId);
          if (!native) throw new ReleaseGroupingRestartRequired();
          for (const home of homesByPool[poolId]!) {
            const observed = await native.count(home.partition);
            if (
              !observed ||
              typeof observed.position !== 'bigint' ||
              observed.position < 0n ||
              !Number.isSafeInteger(observed.count) ||
              observed.count < 0 ||
              observed.position.toString() !== home.position
            )
              throw new ReleaseGroupingRestartRequired();
            positions.push([poolId, home.partition, observed.position.toString(), observed.count]);
          }
        }
        return {
          releaseDigest: current.digest,
          physical,
          epoch: createHash('sha256').update(JSON.stringify(positions)).digest('hex'),
          calendarReadyFor: ready === 1 ? physical : null,
        };
      },
    };
    const cut = await observeReleaseSearchCandidates(pools, nativeContext);
    const homeByPartition = new Map<number, { pool: ReleaseSearchCandidatePool; position: string }>();
    for (const retained of cut.names.pools) {
      const owner = pools.find(({ id }) => id === retained.id);
      if (!owner) throw new ReleaseGroupingRestartRequired();
      for (const home of retained.population.homes)
        homeByPartition.set(home.partition, { pool: owner, position: home.position });
    }
    const poolFor = (partition: number): ReleaseSearchCandidatePool => {
      const retained = homeByPartition.get(partition);
      if (retained) return retained.pool;
      if (pools.length === 1) return pools[0]!;
      throw new ReleaseGroupingUnavailable();
    };
    const sourceFor = (candidate: ReleaseSearchCandidatePool) => poolSources.get(candidate.id)!;
    const sourceReservation = (
      candidate: ReleaseSearchCandidatePool,
      fields: Partial<ReleaseSearchCandidateReservation>,
    ) => reserve({
      pool: candidate.id,
      observations: 0,
      ownerReads: 0,
      nameSeeks: 0,
      keys: fields.keys ?? 0,
      sourceReads: 0,
      completeWorkLinkReads: 0,
      authorityObservations: 0,
      ...fields,
    });
    async function readPool(candidate: ReleaseSearchCandidatePool, partition: number, ids: readonly string[]) {
      if (ids.length > REQUEST_SOURCE_KEYS) throw new ReleaseGroupingUnavailable();
      sourceReservation(candidate, { sourceReads: 1, hydrationReads: 1, keys: ids.length });
      const snapshot = await sourceFor(candidate).read(partition, ids);
      const subjects = validateRequestSourceSnapshot(snapshot, partition, ids);
      const retained = homeByPartition.get(partition);
      if (retained && (retained.pool.id !== candidate.id || snapshot.position.toString() !== retained.position))
        throw new ReleaseGroupingRestartRequired();
      if (
        !retained &&
        snapshot.subjects.some((subject) => subject.visibility === 'visible' && subject.redirect === null)
      )
        throw new ReleaseGroupingRestartRequired();
      return { snapshot, subjects };
    }
    const routedSource: SubjectSource = {
      async read(partition, ids) {
        return (await readPool(poolFor(partition), partition, ids)).snapshot;
      },
      async count(partition) {
        const candidate = poolFor(partition);
        sourceReservation(candidate, { sourceReads: 1, hydrationReads: 1 });
        return sourceFor(candidate).count(partition);
      },
      ...(pools.every(({ source: native }) => !!native.matchRelationFacets)
        ? {
            async matchRelationFacets(partition: number, probes: readonly RelationFacetProbe[]) {
              const candidate = poolFor(partition);
              const matcher = sourceFor(candidate).matchRelationFacets;
              if (!matcher) throw new ReleaseGroupingUnavailable();
              sourceReservation(candidate, { relationFacetReads: 1, keys: probes.length });
              return matcher.call(sourceFor(candidate), partition, probes);
            },
          }
        : {}),
      ...(pools.every(({ source: native }) => !!native.prepareRelationFacets)
        ? {
            async prepareRelationFacets(probes: readonly RelationFacetProbe[]): Promise<RetainedRelationFacetPage> {
              const byPool = new Map<ReleaseSearchCandidatePool, { probe: RelationFacetProbe; index: number }[]>();
              for (const [index, probe] of probes.entries()) {
                const candidate = poolFor(subjectPartition(probe.subject));
                byPool.set(candidate, [...(byPool.get(candidate) ?? []), { probe, index }]);
              }
              const retained = [] as { page: RetainedRelationFacetPage; entries: { index: number }[] }[];
              for (const [candidate, entries] of byPool) {
                const prepare = sourceFor(candidate).prepareRelationFacets;
                if (!prepare) throw new ReleaseGroupingUnavailable();
                sourceReservation(candidate, { relationFacetReads: 1, keys: entries.length });
                retained.push({ page: await prepare(entries.map(({ probe }) => probe)), entries });
              }
              return {
                bounds: retained.flatMap(({ page }) => page.bounds),
                async match() {
                  const values: (boolean | 'not_proven')[] = new Array(probes.length);
                  for (const { page, entries } of retained) {
                    const pageValues = await page.match();
                    if (pageValues.length !== entries.length) throw new ReleaseGroupingUnavailable();
                    for (const [index, { index: resultIndex }] of entries.entries()) values[resultIndex] = pageValues[index]!;
                  }
                  if (values.some((value) => value === undefined)) throw new ReleaseGroupingUnavailable();
                  return values;
                },
                async revalidate() {
                  for (const { page } of retained) if (!(await page.revalidate())) return false;
                  return true;
                },
              };
            },
          }
        : {}),
    };

    async function readCurrent(ids: readonly string[]): Promise<Map<string, IndexedSubject>> {
      if (new Set(ids).size !== ids.length || ids.length > 256) throw new ReleaseGroupingUnavailable();
      const byPartition = new Map<number, string[]>();
      for (const id of ids) {
        const partition = subjectPartition(id);
        byPartition.set(partition, [...(byPartition.get(partition) ?? []), id]);
      }
      const result = new Map<string, IndexedSubject>();
      for (const [partition, values] of byPartition) {
        const candidate = poolFor(partition);
        for (let offset = 0; offset < values.length; offset += REQUEST_SOURCE_KEYS) {
          const page = values.slice(offset, offset + REQUEST_SOURCE_KEYS);
          const snapshot = await readPool(candidate, partition, page);
          for (const [id, subject] of snapshot.subjects) result.set(id, subject);
        }
      }
      return result;
    }
    const workType = (subject: IndexedSubject) =>
      subject.type === 'schema:CreativeWork' ||
      !!(Object.hasOwn(active.release.types, subject.type) &&
        active.release.types[subject.type]?.bases?.includes('schema:CreativeWork'));
    async function liveRelationRelease() {
      const current = await liveRelease();
      if (!current || current.digest !== active.digest || current.head !== active.head)
        throw new ReleaseGroupingRestartRequired();
      return { release: current.release, digest: current.digest, head: current.head };
    }
    async function matching(ids: readonly string[], current: ReadonlyMap<string, IndexedSubject>) {
      const hits = [...current.values()].map((subject) => ({
        id: subject.id,
        partition: subjectPartition(subject.id),
        securityRevision: subject.securityRevision,
        matched: [...clauses.keys()],
      }));
      const checked = await sourceRequest(() =>
        checkHits(routedSource, hits, clauses, {
          filter,
          relationProperties,
          spoilerThreshold: request.spoilerThreshold,
          observeRelationRelease: liveRelationRelease,
        }),
      );
      if (checked.relationRejected) throw indexNotReady();
      const passed = new Map(checked.passed.map(({ subject }) => [subject.id, subject]));
      if (normalized.text)
        for (const [id, subject] of passed) if (!holdsCurrentText(subject, normalized.text)) passed.delete(id);
      return passed;
    }
    async function currentLinks(ids: readonly string[]) {
      const result = new Map<string, Awaited<ReturnType<typeof releaseWorkLink>>>();
      const partitions = new Map<number, string[]>();
      for (const id of ids) {
        const partition = subjectPartition(id);
        partitions.set(partition, [...(partitions.get(partition) ?? []), id]);
      }
      for (const [partition, values] of partitions) {
        const candidate = poolFor(partition);
        const links = sourceFor(candidate).readCompleteWorkLinks;
        if (!links) throw new ReleaseGroupingUnavailable();
        const home = homeByPartition.get(partition);
        if (!home || home.pool.id !== candidate.id) throw new ReleaseGroupingRestartRequired();
        sourceReservation(candidate, { completeWorkLinkReads: 1, keys: values.length });
        const evidence = await links.call(sourceFor(candidate), partition, values);
        if ([...evidence.keys()].some((id) => !values.includes(id))) throw new ReleaseGroupingUnavailable();
        for (const id of values) {
          const value = evidence.get(id);
          if (
            !value ||
            typeof value.complete !== 'boolean' ||
            !Array.isArray(value.values) ||
            value.values.some(
              (entry) => !entry || (entry.kind !== 'unknown' && (entry.kind !== 'work' || !canonicalId(entry.id))),
            )
          )
            throw new ReleaseGroupingUnavailable();
          result.set(id, releaseWorkLink(value.complete, value.values));
        }
      }
      const targets = [...new Set([...result.values()].flatMap((link) => (link.kind === 'linked' ? [link.work] : [])))];
      for (const target of targets) {
        const home = homeByPartition.get(subjectPartition(target));
        if (!home) {
          result.forEach((link, id) => {
            if (link.kind === 'linked' && link.work === target) result.set(id, { kind: 'unknown' });
          });
          continue;
        }
        const found = await readCurrent([target]);
        const targetSubject = found.get(target);
        if (
          !targetSubject ||
          targetSubject.visibility !== 'visible' ||
          targetSubject.redirect !== null ||
          !workType(targetSubject)
        )
          result.forEach((link, id) => {
            if (link.kind === 'linked' && link.work === target) result.set(id, { kind: 'unknown' });
          });
      }
      return result;
    }
    async function serialize(subjects: readonly IndexedSubject[]): Promise<PublicSearchHit[]> {
      if (!subjects.length) return [];
      const byPool = new Map<string, number>();
      for (const subject of subjects) {
        const owner = poolFor(subjectPartition(subject.id));
        byPool.set(owner.id, (byPool.get(owner.id) ?? 0) + 1);
      }
      for (const [id, count] of byPool)
        sourceReservation(pools.find(({ id: candidate }) => candidate === id)!, {
          serializationBytes: count * 32_768,
          keys: count,
        });
      const hits = subjects.map((subject) => projectHit(subject, options));
      if (options.properties) {
        const facts = await sourceRequest(() =>
          projectFacts(
            routedSource,
            subjects,
            options.properties!,
            options.languages,
            request.spoilerThreshold,
          ),
        );
        hits.forEach((hit, index) => (hit.facts = facts[index]!));
      }
      return sourceRequest(() => publicHitFigures(pool, hits));
    }

    const groupingSource = createReleaseSearchGroupingSource<PublicSearchHit, PublicSearchHit>({
      pools,
      release: active.release,
      cut,
      context: nativeContext,
      async works(_request, ids) {
        const current = await readCurrent(ids);
        const selected = [...current.values()].filter(
          (subject) => subject.visibility === 'visible' && subject.redirect === null && workType(subject),
        );
        const cards = await serialize(selected);
        return new Map(cards.map((card) => [card.id, card]));
      },
      async releases(_request, ids) {
        const current = await readCurrent(ids);
        const links = await currentLinks(ids);
        const matched = await matching(ids, current);
        const selected = ids.flatMap((id) => {
          const subject = matched.get(id);
          const link = links.get(id);
          return subject && link ? [{ subject, link }] : [];
        });
        const cards = await serialize(selected.map(({ subject }) => subject));
        return new Map(
          selected.map(({ link }, index) => [cards[index]!.id, { card: cards[index]!, link }]),
        );
      },
    });
    const page = operation === 'children'
      ? await readReleaseChildrenPage({
          source: groupingSource,
          request,
          principal,
          work: submitted.work!,
          cursors,
          ...(submitted.cursor ? { cursor: submitted.cursor } : {}),
          now,
        })
      : await readReleaseGroupsPage({
          source: groupingSource,
          request,
          principal,
          cursors,
          ...(submitted.cursor ? { cursor: submitted.cursor } : {}),
          now,
        });
    const as_of = await asOf(generation);
    return operation === 'children'
      ? { operation, ...page, as_of }
      : { operation, ...page, as_of };
  }

  const service = {
    async search(
      principal: 'anonymous' | `account:${string}`,
      request: SearchRequest,
      now = clock().getTime(),
      active?: { digest: string; head?: number; release: FilterRelease } | null,
      readContext?: PublicSearchReadContext,
    ) {
      request = ownSubjectRequest(request);
      const { text, filter, sort, limit, hitOptions, spoilerThreshold, bindingRequest } = validate(request);
      // One lookup serves filter admission and the requested properties.
      const native = active === undefined && !releaseOverride ? await activeRelease(pool) : active;
      const current = native?.release ?? (releaseOverride ? await release() : undefined);
      if (publicFilters && !native) throw indexNotReady();
      const kinds: KindSnapshot | undefined = current
        ? compileKinds(current, native?.digest ?? kindDigest(current))
        : undefined;
      const releaseBinding = native ? { digest: native.digest, head: native.head } : null;
      const assertCurrentRelease = async () => {
        if (!current) return;
        if (releaseBinding) {
          const latest = await sourceRequest(() => activeRelease(pool));
          if (
            latest?.digest !== releaseBinding.digest ||
            (releaseBinding.head !== undefined && latest.head !== releaseBinding.head)
          )
            throw new ProblemError('search_restart_required');
        } else if (releaseOverride) {
          const latest = await sourceRequest(release);
          if (!latest || kindDigest(latest) !== kinds!.digest) throw new ProblemError('search_restart_required');
        }
      };
      if ((filter || hitOptions.properties) && !current)
        throw new ProblemError('semantic_not_ready', { headers: { 'retry-after': '1' } });
      const admitted = await admitQuery(
        text,
        filter,
        current ?? undefined,
        request.population !== undefined,
        spoilerThreshold,
        !request.population,
      );
      if (hitOptions.properties) admitProperties(hitOptions.properties, current!);
      if (request.kindCursor !== undefined && typeof request.kindCursor !== 'string')
        invalid('/kindCursor', 'invalid_type');
      if (request.population) {
        // Selected populations never query public rating fields or acquire a public result cache.
        if (request.kindCursor !== undefined) unsupported('/kindCursor');
        const binding = {
          operation: 'subjects.search.realm_rating',
          principal,
          request: { ...bindingRequest, meaningDigest: kinds?.digest ?? null },
        };
        // Authenticate before native authority/evidence reads, including malformed continuations.
        if (request.cursor !== undefined) {
          const decoded = await decodeSearchCursor(cursors, binding, request.cursor, now);
          if (!decoded.ok) {
            if (decoded.reason === 'expired') throw new ProblemError('search_restart_required');
            invalid('/cursor', 'invalid_format');
          }
        }
        const ordered = await readRealmRatingOrder({
          ratings: realmRatings,
          source,
          cursors,
          binding,
          limit,
          now,
          ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
          query: {
            principal,
            populationId: request.population.realm,
            release: current ?? undefined,
            meaningDigest: kinds?.digest,
            text,
            filter: admitted,
            deadline: readContext?.deadline ?? Date.now() + 10_000,
            ...(readContext?.realmAuthority ? { authority: readContext.realmAuthority } : {}),
          },
        });
        const results = ordered.subjects.map((subject) => projectHit(subject, hitOptions));
        if (hitOptions.properties) {
          const facts = await sourceRequest(() =>
            projectFacts(source, ordered.subjects, hitOptions.properties!, hitOptions.languages),
          );
          results.forEach((hit, index) => (hit.facts = facts[index]!));
        }
        const response: PublicSearchPage = {
          subjects: await sourceRequest(() => publicHitFigures(pool, results)),
          next: ordered.next,
          as_of: ordered.as_of,
        };
        await readContext?.complete(response);
        await ordered.finalize();
        await assertCurrentRelease();
        return response;
      }
      const realmScopedRequest = admitted !== undefined && containsRealmPredicate(admitted);
      const scopedRequest = admitted !== undefined && (containsOwnerPredicate(admitted) || realmScopedRequest);
      let scope: ReturnType<typeof createSearchScopeForService> | undefined;
      let preparedScope: Awaited<ReturnType<NonNullable<typeof scope>['prepare']>> | undefined;
      let scopeWork: ScopeWork | undefined;
      if (scopedRequest) {
        const options = readContext?.scope;
        if (!options) throw indexNotReady();
        scope = createSearchScopeForService(service, options);
        scopeWork = new ScopeWork(scopeAllowance(700, randomUUID()));
        if (realmScopedRequest) {
          if (containsUnsupportedDiscoveryLeaf(admitted)) unsupported('/filter');
          const preparedRealm = await sourceRequest(() =>
            scope!.realm.prepare(admitted as DiscoveryFilterDocument, scopeWork!.remaining()),
          );
          scopeWork.native(preparedRealm.work);
          const generation = await indexRequest(aliasGeneration);
          const format = await indexRequest(() => readSubjectSortFormat(client, prefix, generation));
          if (format !== SUBJECT_SORT_FORMAT) throw indexNotReady();
          const index = subjectIndexName(prefix, generation);
          const indexUuid = await indexRequest(() => discoveryIndexUuid(client, index));
          const compiledText = text ? compileText(text, { field: 'search_text', prefix: 't' }) : undefined;
          const textBoost = compiledText?.leaves
            .filter((leaf) => !leaf.negated)
            .map((leaf) => leaf.value)
            .join(' ');
          const searchBasis = scope!.realm.searchBasis(preparedRealm.scope, {
            ...(request.text === undefined ? {} : { text: request.text }),
            ...(compiledText ? { textQuery: compiledText.query, textBoost: textBoost! } : {}),
            generation,
            indexUuid,
          });
          const binding = {
            operation: 'subjects.search',
            request: bindSearchScopeCursorRequest(bindingRequest, searchBasis),
            principal,
          };
          let cursor: Awaited<ReturnType<typeof decodeSearchCursor>> | undefined =
            request.cursor === undefined ? undefined : await decodeSearchCursor(cursors, binding, request.cursor, now);
          if (cursor && !cursor.ok) {
            if (cursor.reason === 'expired') throw new ProblemError('search_restart_required');
            invalid('/cursor', 'invalid_format');
          }
          if (cursor?.ok && cursor.generation !== generation) throw new ProblemError('search_restart_required');
          const after = cursor?.ok ? scopeCursorAfter('name', cursor.after) : null;
          const kindAfter =
            request.kindCursor === undefined
              ? undefined
              : kinds
                ? await decodeKindCursor(cursors, binding, request.kindCursor, generation, kinds.digest, now)
                : (() => {
                    throw new ProblemError('search_restart_required');
                  })();
          const page = await sourceRequest(() =>
            scope!.realm.searchPage(preparedRealm.scope, {
              basis: searchBasis,
              ...(request.text === undefined ? {} : { text: request.text }),
              ...(compiledText ? { textQuery: compiledText.query, textBoost: textBoost! } : {}),
              generation,
              indexUuid,
              after,
              quota: limit,
              allowance: scopeWork!.remaining(),
            }),
          );
          scopeWork.native(page.work);
          if (page.status !== 'ready' || !isDeepStrictEqual(page.basis, searchBasis)) throw indexNotReady();
          const shown = [...page.subjects];
          if (shown.length !== page.hits.length) throw new ProblemError('search_restart_required');
          const results = shown.map((subject) => projectHit(subject, hitOptions));
          if (hitOptions.properties) {
            const facts = await sourceRequest(() =>
              projectFacts(source, shown, hitOptions.properties!, hitOptions.languages),
            );
            results.forEach((hit, index) => (hit.facts = facts[index]!));
          }
          const publicResults = await sourceRequest(() => publicHitFigures(pool, results));
          const as_of = await asOf(generation);
          const witnesses = new Map<string, number>();
          if (request.cursor === undefined && request.kindCursor === undefined)
            for (const subject of shown.slice(0, 2))
              witnesses.set(subject.type, (witnesses.get(subject.type) ?? 0) + 1);
          const metadata = kinds?.page(kindAfter, hitOptions.languages ?? [], witnesses);
          const nextAfter = page.after;
          if (!page.exhausted && nextAfter === null) throw new ProblemError('search_restart_required');
          const response: PublicSearchPage = {
            subjects: publicResults,
            ...(metadata
              ? {
                  kinds: {
                    values: metadata.values,
                    next:
                      metadata.after === null
                        ? null
                        : await encodeKindCursor(cursors, binding, generation, kinds!.digest, metadata.after, now),
                  },
                }
              : {}),
            next: page.exhausted
              ? null
              : await encodeSearchCursor(cursors, binding, { generation, after: [...nextAfter!] }, now),
            as_of,
          };
          await readContext?.complete(response);
          const currentHits = await sourceRequest(() => checkHits(source, page.hits, new Map()));
          if (
            currentHits.passed.length !== shown.length ||
            currentHits.passed.some(({ subject }, position) => subject.id !== shown[position]!.id)
          )
            throw new ProblemError('search_restart_required');
          const final = await sourceRequest(() =>
            scope!.realm.evaluate(
              preparedRealm.scope,
              shown.map((subject) => subject.id),
              scopeWork!.remaining(),
            ),
          );
          scopeWork.native(final.work);
          if (
            final.basis !== preparedRealm.scope.basis ||
            final.values.length !== shown.length ||
            final.values.some((value) => value !== true)
          )
            throw new ProblemError('search_restart_required');
          if ((await indexRequest(() => discoveryIndexUuid(client, index))) !== indexUuid)
            throw new ProblemError('search_restart_required');
          if ((await indexRequest(freshAliasGeneration)) !== generation)
            throw new ProblemError('search_restart_required');
          return response;
        } else {
          const nativeOrder = !text && (sort === 'name' || sort === 'collections') ? sort : undefined;
          preparedScope = await sourceRequest(() =>
            scope!.prepare(admitted as FilterDocument, {
              releaseDigest: native?.digest ?? kindDigest(current!),
              ...(nativeOrder ? { nativeOrder, pageSize: limit } : {}),
              allowance: scopeWork!.remaining(),
            }),
          );
          scopeWork.native(scope.work(preparedScope));
        }
      }
      const cursorRequest = preparedScope
        ? bindSearchScopeCursorRequest(bindingRequest, preparedScope.basis)
        : bindingRequest;
      const binding = { operation: 'subjects.search', request: cursorRequest, principal };
      // Preserve a known unsafe candidate total across continuations in the signed
      // scope; the request/principal binding and keyset payload stay unchanged.
      const lowerBoundBinding = { ...binding, operation: 'subjects.search.lower_bound' };
      let inexact = false;
      let cursor =
        request.cursor === undefined ? undefined : await decodeSearchCursor(cursors, binding, request.cursor, now);
      if (cursor && !cursor.ok && cursor.reason === 'invalid') {
        cursor = await decodeSearchCursor(cursors, lowerBoundBinding, request.cursor!, now);
        inexact = cursor.ok;
      }
      if (cursor && !cursor.ok) {
        if (cursor.reason === 'expired') throw new ProblemError('search_restart_required');
        invalid('/cursor', 'invalid_format');
      }

      const retained = cursor?.ok ? retainedSearchContinuation(cursor.after) : null;
      if (publicFilters && cursor && !retained) throw new ProblemError('search_restart_required');
      if (!publicFilters && retained) throw new ProblemError('search_restart_required');
      // Authenticate the original operation/request/viewer before reading dynamic rating metadata.
      const rating = sort === 'rating' ? await ratingEpoch() : undefined;
      if (
        retained &&
        (rating
          ? !retained.rating ||
            retained.rating.questionId !== rating.questionId ||
            retained.rating.populationId !== rating.populationId ||
            retained.rating.priorEpoch !== rating.priorEpoch
          : retained.rating !== undefined)
      )
        throw new ProblemError('search_restart_required');
      let ratingPhase: RatingPhase | undefined;
      if (rating) {
        if (request.cursor !== undefined && !retained) {
          const decoded = await decodeRatingCursor(
            cursors,
            inexact ? lowerBoundBinding : binding,
            rating,
            request.cursor,
            now,
          );
          if (!decoded.ok) {
            if (decoded.reason === 'restart' || decoded.reason === 'expired')
              throw new ProblemError('search_restart_required');
            invalid('/cursor', 'invalid_format');
          }
          cursor = decoded;
          ratingPhase = decoded.phase;
        }
      }
      // Pin the active generation before querying, including empty queries. Every
      // refill targets that physical index even if the alias switches during validation.
      const generation = await indexRequest(aliasGeneration);
      if (cursor && cursor.generation !== generation) throw new ProblemError('search_restart_required');
      if (
        retained &&
        (retained.queried.consumer.physicalTarget !== subjectIndexName(prefix, generation) ||
          retained.queried.consumer.meaningDigest !== native?.digest)
      )
        throw new ProblemError('search_restart_required');
      const format = await indexRequest(() => readSubjectSortFormat(client, prefix, generation));
      if (format !== SUBJECT_SORT_FORMAT) throw indexNotReady();
      const calendarFormat =
        admitted && containsCalendarRange(admitted)
          ? await indexRequest(() => readSubjectCalendarFormat(client, prefix, generation))
          : null;

      const compiledText = text ? compileText(text, { field: 'search_text', prefix: 't' }) : undefined;
      const compiledFilter =
        admitted && !preparedScope
          ? compileFilter(admitted as FilterDocument, {
              prefix: 'f',
              relationOverflow: true,
              ...(calendarFormat === null ? {} : { calendarFormat }),
            })
          : undefined;
      const overflowProperties = [
        ...new Set(compiledFilter?.leaves.flatMap((leaf) => (leaf.facet === 'statement' ? [leaf.property] : []))),
      ];
      const relationProperties = overflowProperties.filter((property) => relationFacetProperty(current!, property));
      const clauses = new Map<string, FactClause>(compiledFilter?.leaves.map((leaf) => [leaf.name, leaf]));
      const plan = {
        ...(compiledText
          ? {
              query: compiledText.query,
              boost: compiledText.leaves
                .filter((leaf) => !leaf.negated)
                .map((leaf) => leaf.value)
                .join(' '),
            }
          : {}),
        ...(compiledFilter ? { filter: compiledFilter.query } : {}),
        ...(overflowProperties.length ? { overflowProperties } : {}),
        sort,
      };
      const kindAfter =
        request.kindCursor === undefined
          ? undefined
          : kinds
            ? await decodeKindCursor(cursors, binding, request.kindCursor, generation!, kinds.digest, now)
            : (() => {
                throw new ProblemError('search_restart_required');
              })();
      let overflow = false;
      const witnesses = new Map<string, number>();
      let witnessCount = 0;
      // Observe every checked snapshot, including rejected candidates: current overflow can
      // precede its indexed marker, so an exact candidate total would also be unsafe there.
      const sourcePositions = new Map<number, bigint>();
      const disclosureSource: SubjectSource =
        overflowProperties.length || rating
          ? {
              async read(partition, ids) {
                const snapshot = await source.read(partition, ids);
                validateRequestSourceSnapshot(snapshot, partition, ids);
                if (rating) {
                  const previous = sourcePositions.get(partition);
                  if (previous !== undefined && previous !== snapshot.position) throw indexNotReady();
                  sourcePositions.set(partition, snapshot.position);
                }
                overflow ||= snapshot.subjects.some((subject) =>
                  subject.relationFacetOverflow?.some((property) => overflowProperties.includes(property)),
                );
                return snapshot;
              },
              count: (partition) => source.count(partition),
              ...(source.prepareRelationFacets
                ? { prepareRelationFacets: source.prepareRelationFacets.bind(source) }
                : {}),
              ...(source.matchRelationFacets ? { matchRelationFacets: source.matchRelationFacets.bind(source) } : {}),
            }
          : source;
      const evaluateScope = async (ids: readonly string[]) => {
        if (!scope || !preparedScope || !scopeWork) throw indexNotReady();
        if (ids.length === 0) return [] as const;
        const evaluation = await sourceRequest(() =>
          scope.evaluate(preparedScope!, [...ids], scopeEvaluationReservation(scopeWork!, ids.length)),
        );
        scopeWork.native(scope.work(evaluation));
        if (
          evaluation.basis.canonical !== preparedScope.basis.canonical ||
          evaluation.values.length !== ids.length ||
          evaluation.progress !== null ||
          evaluation.values.includes('not_proven')
        )
          throw indexNotReady();
        return evaluation.values;
      };
      const checkCandidates = async (hits: readonly NativeSearchHit[]) => {
        sourcePositions.clear();
        const { passed, relationRejected } = await sourceRequest(() =>
          checkHits(
            disclosureSource,
            hits,
            clauses,
            admitted && !preparedScope
              ? {
                  filter: admitted,
                  relationProperties,
                  ...(spoilerThreshold === undefined ? {} : { spoilerThreshold }),
                  observeRelationRelease: async () => {
                    await assertCurrentRelease();
                    return current
                      ? { release: current, digest: kinds!.digest, head: releaseBinding?.head ?? 0 }
                      : null;
                  },
                }
              : undefined,
          ),
        );
        inexact ||= relationRejected === true;
        const ratingAccepted = rating ? await ratingCandidates([...hits], rating, sourcePositions) : undefined;
        const subjects = new Map(passed.map(({ hit, subject }) => [hit, subject]));
        let scopedMatches: Set<string> | undefined;
        if (scope && preparedScope && scopeWork && passed.length) {
          const ids = passed.map(({ subject }) => subject.id);
          const values = await evaluateScope(ids);
          scopedMatches = new Set(ids.filter((_, index) => values[index] === true));
        }
        const checked = new Map<(typeof hits)[number], IndexedSubject>();
        for (const hit of hits) {
          if (rating && hit.ratingPhase !== 'scored' && hit.ratingPhase !== 'unscored') throw indexNotReady();
          const subject = subjects.get(hit);
          if (
            subject &&
            (!scopedMatches || scopedMatches.has(subject.id)) &&
            (!ratingAccepted || ratingAccepted.has(hit))
          )
            checked.set(hit, subject);
        }
        return checked;
      };
      if (
        scope &&
        preparedScope &&
        scopeWork &&
        !text &&
        (sort === 'id' || sort === 'name' || sort === 'collections') &&
        !hitOptions.descriptions &&
        !hitOptions.properties
      ) {
        const nativeHits: NativeSearchHit[] = [];
        let after: SearchSortValue[] | null = null;
        let exhausted = false;
        if (sort === 'id') {
          const afterSubject = cursor?.ok ? scopeCursorAfter('id', cursor.after) : null;
          const page = await sourceRequest(() =>
            scope!.prefix(preparedScope!, {
              afterSubject,
              quota: limit,
              budget: Math.min(256, limit + 1),
              allowance: scopeWork!.remaining(),
            }),
          );
          if (page.basis.canonical !== preparedScope.basis.canonical || !page.usage.work)
            throw new ProblemError('search_restart_required');
          scopeWork.native(page.usage.work);
          nativeHits.push(...page.hits);
          exhausted = page.exhausted;
          after = page.coveredThrough === null ? null : [page.coveredThrough];
          if (!exhausted && after === null) throw indexNotReady();
          if (nativeHits.length < limit && !exhausted) throw indexNotReady();
        } else if (sort === 'name') {
          let orderedAfter: readonly [string | null, string] | null = cursor?.ok
            ? scopeCursorAfter('name', cursor.after)
            : null;
          let covered: readonly [string | null, string] | null = null;
          while (nativeHits.length < limit) {
            const quota = Math.min(99, limit - nativeHits.length);
            const page = await sourceRequest(() =>
              scope!.orderedPrefix(preparedScope!, {
                order: 'name',
                after: orderedAfter,
                quota,
                budget: quota + 1,
                allowance: scopeWork!.remaining(),
              }),
            );
            if (page.basis.canonical !== preparedScope.basis.canonical)
              throw new ProblemError('search_restart_required');
            if (page.order !== 'name') throw new ProblemError('search_restart_required');
            scopeWork.native(page.usage.work);
            nativeHits.push(...page.hits.map((hit) => ({ ...hit, sort: [...hit.sort] })));
            covered = page.coveredThrough;
            exhausted = page.exhausted;
            if (nativeHits.length >= limit || exhausted) break;
            if (page.hits.length === 0 || covered === null) throw indexNotReady();
            orderedAfter = covered;
          }
          after = covered === null ? null : [...covered];
          if (!exhausted && after === null) throw indexNotReady();
          if (nativeHits.length < limit && !exhausted) throw indexNotReady();
        } else {
          let orderedAfter: readonly [number, string | null, string] | null = cursor?.ok
            ? scopeCursorAfter('collections', cursor.after)
            : null;
          let covered: readonly [number, string | null, string] | null = null;
          while (nativeHits.length < limit) {
            const quota = Math.min(99, limit - nativeHits.length);
            const page = await sourceRequest(() =>
              scope!.orderedPrefix(preparedScope!, {
                order: 'collections',
                after: orderedAfter,
                quota,
                budget: quota + 1,
                allowance: scopeWork!.remaining(),
              }),
            );
            if (page.basis.canonical !== preparedScope.basis.canonical)
              throw new ProblemError('search_restart_required');
            if (page.order !== 'collections') throw new ProblemError('search_restart_required');
            scopeWork.native(page.usage.work);
            nativeHits.push(...page.hits.map((hit) => ({ ...hit, sort: [...hit.sort] })));
            covered = page.coveredThrough;
            exhausted = page.exhausted;
            if (nativeHits.length >= limit || exhausted) break;
            if (page.hits.length === 0 || covered === null) throw indexNotReady();
            orderedAfter = covered;
          }
          after = covered === null ? null : [...covered];
          if (!exhausted && after === null) throw indexNotReady();
          if (nativeHits.length < limit && !exhausted) throw indexNotReady();
        }
        if (new Set(nativeHits.map((hit) => hit.id)).size !== nativeHits.length) throw indexNotReady();
        const checked = await checkCandidates(nativeHits);
        if (checked.size !== nativeHits.length) throw new ProblemError('search_restart_required');
        const shown = nativeHits.map((hit) => checked.get(hit)!);
        const results = shown.map((subject) => projectHit(subject, hitOptions));
        const publicResults = await sourceRequest(() => publicHitFigures(pool, results));
        const as_of = await asOf(generation!);
        const witnesses = new Map<string, number>();
        for (const subject of shown.slice(0, 2)) witnesses.set(subject.type, (witnesses.get(subject.type) ?? 0) + 1);
        const metadata = kinds?.page(kindAfter, hitOptions.languages ?? [], witnesses);
        const response: PublicSearchPage = {
          subjects: publicResults,
          ...(metadata
            ? {
                kinds: {
                  values: metadata.values,
                  next:
                    metadata.after === null
                      ? null
                      : await encodeKindCursor(cursors, binding, generation!, kinds!.digest, metadata.after, now),
                },
              }
            : {}),
          next: exhausted
            ? null
            : await encodeSearchCursor(cursors, binding, { generation: generation!, after: after ?? [] }, now),
          as_of,
        };
        await readContext?.complete(response);
        const finalValues = await evaluateScope(shown.map((subject) => subject.id));
        if (finalValues.some((value) => value !== true)) throw new ProblemError('search_restart_required');
        if ((await indexRequest(freshAliasGeneration)) !== generation)
          throw new ProblemError('search_restart_required');
        await assertCurrentRelease();
        return response;
      }
      const runtime = publicFilters?.();
      if (publicFilters && (!runtime || !readContext)) throw indexNotReady();
      const context = { deadline: readContext?.deadline ?? Date.now() + 10_000 };
      const capturePlan = {
        ...plan,
        generation,
        filterDocument: preparedScope ? undefined : (admitted as FilterDocument | undefined),
        text,
        pageSize: limit,
        size: Math.min(200, 2 * limit + 1),
        ...(retained?.frontier.after ? { after: retained.frontier.after } : {}),
        ...(rating
          ? { rating, ...(retained?.frontier.ratingPhase ? { ratingPhase: retained.frontier.ratingPhase } : {}) }
          : {}),
      };
      let operations: PublicFilterConsumerOperations | undefined;
      let capture: PublicFilterConsumerCapture | undefined;
      let disposeRetainedPage: (() => Promise<void>) | undefined;
      try {
        if (runtime) {
          if (retained) {
            operations = await indexRequest(() => runtime.resumeRequest(retained.queried, context));
          } else {
            // Poll the retained preparation instead of reserving a fresh direct
            // allowance on every retry of the same sparse page.
            const bound = await indexRequest(() =>
              runtime.bindRequest({ plan: capturePlan, snapshot: 'prepared' }, context),
            );
            operations = bound.operations;
            capture = bound.capture;
          }
        }
        const installed = operations;
        const retainedRead = installed
          ? await indexRequest(() =>
              readPublicSearchPage({
                operations: installed,
                context,
                plan: capturePlan,
                ...(capture ? { capture } : {}),
                ...(preparePublic ? { prepare: preparePublic } : {}),
                ...(retained ? { continuation: retained } : {}),
                check: checkCandidates,
                canonicalId: (subject) => subject.id,
              }),
            )
          : undefined;
        disposeRetainedPage = retainedRead?.dispose;
        if (
          retainedRead &&
          (retainedRead.continuation.queried.consumer.physicalTarget !== subjectIndexName(prefix, generation) ||
            retainedRead.continuation.queried.consumer.meaningDigest !== native?.digest)
        )
          throw request.cursor ? new ProblemError('search_restart_required') : indexNotReady();
        const useful =
          retainedRead?.page ??
          (await collectUsefulPage({
            limit,
            frontier: {
              ...(cursor?.after === undefined ? {} : { after: cursor.after }),
              ...(ratingPhase === undefined ? {} : { ratingPhase }),
            },
            read: async ({ after, ratingPhase: phase, size }) => {
              const page = await indexRequest(() =>
                searchSubjectHits(client, prefix, {
                  ...plan,
                  generation,
                  size,
                  ...(after === undefined ? {} : { after }),
                  ...(rating ? { rating, ...(phase ? { ratingPhase: phase } : {}) } : {}),
                }),
              );
              overflow ||= page.overflow === true;
              return page;
            },
            check: checkCandidates,
            canonicalId: (subject) => subject.id,
          }));
        // Never publish a partial page or a raw-candidate continuation on work-bound exhaustion.
        // Native preparation must own the retained input; a request cannot fabricate a job.
        if (useful.status === 'preparing') throw indexNotReady();
        const exhausted = useful.status === 'exhausted';
        const after = useful.frontier.after;
        ratingPhase = useful.frontier.ratingPhase;
        const shown = [...useful.values];
        const results: SearchHit[] = shown.map((subject) => projectHit(subject, hitOptions));
        for (const subject of shown) {
          if (request.cursor === undefined && request.kindCursor === undefined && witnessCount < 2) {
            witnesses.set(subject.type, (witnesses.get(subject.type) ?? 0) + 1);
            witnessCount++;
          }
        }
        if (hitOptions.properties) {
          const facts = await sourceRequest(() =>
            projectFacts(source, shown, hitOptions.properties!, hitOptions.languages),
          );
          results.forEach((hit, index) => (hit.facts = facts[index]!));
        }
        const publicResults = await sourceRequest(() => publicHitFigures(pool, results));
        // Exactly one freshness observation; verify dynamic context after all response work, even for empty pages.
        const as_of = await asOf(generation!);
        if (rating) {
          const currentRating = await ratingEpoch();
          if (
            currentRating.questionId !== rating.questionId ||
            currentRating.populationId !== rating.populationId ||
            currentRating.priorEpoch !== rating.priorEpoch
          )
            throw new ProblemError('search_restart_required');
        }
        const cursorBinding = overflow || inexact ? lowerBoundBinding : binding;
        const metadata = kinds?.page(kindAfter, hitOptions.languages ?? [], retainedRead ? new Map() : witnesses);
        const response: PublicSearchPage = {
          subjects: publicResults,
          ...(metadata
            ? {
                kinds: {
                  values: metadata.values,
                  next:
                    metadata.after === null
                      ? null
                      : await encodeKindCursor(cursors, binding, generation!, kinds!.digest, metadata.after, now),
                },
              }
            : {}),
          next: exhausted
            ? null
            : retainedRead
              ? await encodeRetainedSearchCursor(cursors, cursorBinding, generation!, retainedRead.continuation, now)
              : rating
                ? await encodeRatingCursor(
                    cursors,
                    cursorBinding,
                    rating,
                    { generation: generation!, phase: ratingPhase!, after: after! },
                    now,
                  )
                : await encodeSearchCursor(cursors, cursorBinding, { generation: generation!, after: after! }, now),
          as_of,
        };
        // This operation's final observation must follow all query and source work;
        // another request's in-flight alias read cannot bracket this response.
        await readContext?.complete(response);
        if (scope && preparedScope && shown.length) {
          const finalValues = await evaluateScope(shown.map((subject) => subject.id));
          if (finalValues.some((value) => value !== true)) throw new ProblemError('search_restart_required');
        }
        if ((await indexRequest(freshAliasGeneration)) !== generation)
          throw new ProblemError('search_restart_required');
        if (retainedRead) {
          await indexRequest(retainedRead.finalize);
          await indexRequest(retainedRead.release);
        }
        await assertCurrentRelease();
        return response;
      } finally {
        try {
          // Hydration/cursor failures still release the SAME page use. Disposing
          // failed work never substitutes for the missing final disclosure.
          await disposeRetainedPage?.();
        } finally {
          await operations?.close();
        }
      }
    },

    async releaseSearch(
      principal: ReleaseSearchPrincipal,
      request: ReleaseGroupedSearchRequest,
      now = clock().getTime(),
      context: { deadline: number } = { deadline: deadlineFor(30_000) },
    ): Promise<ReleaseGroupedSearchPage> {
      return groupedReleaseSearch(principal, request, now, context);
    },

    async facets(
      principal: 'anonymous' | `account:${string}`,
      request: FacetRequest,
      now = clock().getTime(),
      context: { deadline: number; scope?: LeafOptions } = { deadline: deadlineFor(30_000) },
    ): Promise<FacetDiscovery200Response> {
      request = ownSubjectRequest(request);
      if (request.scope !== undefined) {
        const provider =
          (await facetProvider?.()) ??
          (publicFilters === undefined ? undefined : await publicFilters().facetProvider());
        if (!provider) throw indexNotReady();
        return readScopedFacetDiscovery(cursors, provider, request, async (scopedRequest) => {
          if (!context.scope) throw indexNotReady();
          if (
            scopedRequest.conditions !== undefined &&
            scopedRequest.filter !== undefined &&
            !isDeepStrictEqual(scopedRequest.conditions, scopedRequest.filter)
          )
            invalid('/conditions', 'invalid_format');
          const submitted = scopedRequest.conditions ?? scopedRequest.filter;
          const effectiveFilter = scopedCatalogueCondition(submitted, scopedRequest.scope);
          const normalized = validate({
            ...(scopedRequest.text === undefined ? {} : { text: scopedRequest.text }),
            filter: effectiveFilter,
          });
          const languages = validateHitOptions({ languages: scopedRequest.languages }).languages;
          const current = await release();
          if (!current) throw new ProblemError('semantic_not_ready', { headers: { 'retry-after': '1' } });
          // The native facet population is pinned to schema:Thing by its registered provider meaning.
          const predicate = normalized.filter ?? { type: { in: ['schema:Thing'] } };
          const admitted = await admitQuery(normalized.text, predicate, current);
          if (!admitted) throw indexNotReady();

          // Content owns Realm enumeration. Keep its scoped facet factory closed until that source is installed.
          if (scopedRequest.scope.kind !== 'collection') throw indexNotReady();
          const scope = createSearchScopeForService(service, context.scope);
          const scopeWork = new ScopeWork(scopeAllowance(700, randomUUID()));
          const prepared = await sourceRequest(() =>
            scope.prepare(admitted, {
              releaseDigest: kindDigest(current),
              allowance: scopeWork.remaining(),
            }),
          );
          scopeWork.native(scope.work(prepared));
          return {
            principal,
            text: normalized.text,
            filter: admitted,
            originalFilter: normalized.filter,
            release: current,
            languages,
            now,
            context: { deadline: context.deadline },
            scope: serviceScopeFacetAdmission({
              resource: scopedRequest.scope,
              scope,
              prepared,
              work: scopeWork,
              principal,
              meaning: {
                text: normalized.text ?? null,
                filter: admitted,
                release: kindDigest(current),
                languages: languages ?? null,
              },
            }),
          };
        });
      }
      const { languages: languageChain, ...facetRequest } = request;
      const { languages } = validateHitOptions({ languages: languageChain });
      const facets = validateFacets(facetRequest);
      admitFacetPage(facets);
      const { text, filter } = validate({
        ...(request.text === undefined ? {} : { text: request.text }),
        filter: request.filter,
      });
      const positions = await authenticateFacetCursors(cursors, {
        principal,
        text,
        originalFilter: filter,
        facets,
        languages,
        now,
      });
      const current = await release();
      if (!current) throw new ProblemError('semantic_not_ready', { headers: { 'retry-after': '1' } });
      validateFacetCursorRelease(positions, current);
      const admitted = await admitQuery(text, filter, current);
      admitFacets(facets, admitted, current);
      // The native factory must resolve the actual registered catalogue/meaning/identity context.
      // Neither preview buckets nor a guessed Global/type configuration can replace this boundary.
      const provider =
        (await facetProvider?.()) ?? (publicFilters === undefined ? undefined : await publicFilters().facetProvider());
      if (!provider) throw indexNotReady();
      return readFacetDiscovery(
        cursors,
        provider,
        {
          principal,
          text,
          filter: admitted,
          originalFilter: filter,
          release: current,
          facets,
          languages,
          now,
          context,
        },
        positions,
      );
    },

    async suggest(
      q: string,
      limit = 8,
      languages?: string[],
      read?: {
        deadline: number;
        filter?: unknown;
        scope?: LeafOptions;
        complete(page: { subjects: Result[]; as_of: string }): Promise<void>;
      },
    ) {
      languages = ownSubjectRequest(languages);
      if (typeof q !== 'string' || q.length > 128 || [...q].length < 1 || [...q].length > 64)
        invalid('/q', 'out_of_range');
      if (!Number.isInteger(limit) || limit < 1 || limit > 10) invalid('/limit', 'out_of_range');
      const options = validateHitOptions({ languages });
      const generation = await discoveryGeneration();
      const parsed = read?.filter === undefined ? undefined : validate({ filter: read.filter }).filter;
      const current = parsed ? await activeRelease(pool) : undefined;
      const admitted = parsed ? await admitQuery(undefined, parsed, current?.release, false) : undefined;
      if (parsed && !admitted) throw indexNotReady();
      if (admitted && !publicFilters) throw indexNotReady();

      if (admitted && publicFilters) {
        if (!current) throw indexNotReady();
        const context = { deadline: read?.deadline ?? Date.now() + 10_000 };
        const bound = await indexRequest(() =>
          publicFilters().bindSuggestion(
            {
              purpose: 'suggest',
              prefix: q,
              size: 2 * limit + 1,
              generation,
              filterDocument: undefined,
              text: undefined,
            },
            context,
          ),
        );
        try {
          const prepare = async () => {
            if (bound.capture.status === 'captured' || bound.capture.status === 'preparing')
              await preparePublic?.(bound.capture.repair);
          };
          if (bound.capture.status !== 'captured') {
            await prepare();
            throw indexNotReady();
          }
          let scope: ReturnType<typeof createSearchScopeForService> | undefined;
          let preparedScope: Awaited<ReturnType<NonNullable<typeof scope>['prepare']>> | undefined;
          let scopeWork: ScopeWork | undefined;
          if (containsOwnerPredicate(admitted)) {
            if (!read?.scope) throw indexNotReady();
            scope = createSearchScopeForService(service, read.scope);
            scopeWork = new ScopeWork(scopeAllowance(700, randomUUID()));
            preparedScope = await sourceRequest(() =>
              scope!.prepare(admitted, {
                releaseDigest: current.digest,
                allowance: scopeWork!.remaining(),
              }),
            );
            scopeWork.native(scope.work(preparedScope));
          }
          return await executeScopedSuggestions({
            operations: bound.operations,
            queried: bound.capture.queried,
            context,
            limit,
            generation,
            filter: admitted,
            release: current.release,
            source,
            ...(scope ? { scope } : {}),
            ...(preparedScope ? { preparedScope } : {}),
            ...(scopeWork ? { scopeWork } : {}),
            readSource: sourceRequest,
            project: (subject) => project(subject, options.languages),
            asOf: () => asOf(generation),
            freshGeneration: () => indexRequest(freshAliasGeneration),
            releaseIsCurrent: async () => (await activeRelease(pool))?.digest === current.digest,
            complete: (page) => read?.complete(page) ?? Promise.resolve(),
            prepare,
          });
        } finally {
          try {
            if (bound.capture.status === 'captured')
              await bound.operations.closeObservation(bound.capture.queried, context);
          } finally {
            await bound.operations.close();
          }
        }
      }
      if (publicFilters) {
        const context = { deadline: read?.deadline ?? Date.now() + 10_000 };
        const bound = await indexRequest(() =>
          publicFilters().bindSuggestion(
            {
              purpose: 'suggest',
              prefix: q,
              size: 2 * limit,
              generation,
              filterDocument: undefined,
              text: undefined,
            },
            context,
          ),
        );
        const preparing = async (): Promise<never> => {
          if (bound.capture.status === 'captured' || bound.capture.status === 'preparing')
            await preparePublic?.(bound.capture.repair);
          throw indexNotReady();
        };
        try {
          if (bound.capture.status !== 'captured') return await preparing();
          const observation = bound.capture.queried;
          const queried = await indexRequest(() => bound.operations.query(observation, context));
          if (queried.status !== 'queried') return await preparing();
          const { passed } = await sourceRequest(() =>
            checkHits(
              source,
              queried.result.map((hit) => ({ ...hit, matched: [] })),
              new Map(),
            ),
          );
          const response = {
            subjects: passed.slice(0, limit).map(({ subject }) => project(subject, options.languages)),
            as_of: await asOf(generation),
          };
          await read?.complete(response);
          if ((await indexRequest(freshAliasGeneration)) !== generation)
            throw new ProblemError('search_restart_required');
          const final = await bound.operations.readStatus(
            { queried: queried.queried, execution: queried.execution },
            context,
          );
          if (final.status !== 'observed' || final.blocking.length) return await preparing();
          return response;
        } finally {
          try {
            if (bound.capture.status === 'captured')
              await bound.operations.closeObservation(bound.capture.queried, context);
          } finally {
            await bound.operations.close();
          }
        }
      }
      const hits = await indexRequest(() => suggestSubjects(client, prefix, { text: q, size: 2 * limit, generation }));
      const { passed } = await sourceRequest(() =>
        checkHits(
          source,
          hits.map((hit) => ({ ...hit, matched: [] })),
          new Map(),
        ),
      );
      const response = {
        subjects: passed.slice(0, limit).map(({ subject }) => project(subject, options.languages)),
        as_of: await asOf(generation),
      };
      await read?.complete(response);
      if ((await indexRequest(freshAliasGeneration)) !== generation) throw new ProblemError('search_restart_required');
      return response;
    },
  };
  registerSearchScopeRuntime(service, {
    pool,
    client,
    prefix,
    source,
    release,
    clock,
    ...(realmRelease ? { realmRelease } : {}),
    ...(realmSubjects ? { realmSubjects } : {}),
    ...(realmSubjectCapabilities ? { realmSubjectCapabilities } : {}),
  });
  return service;
}

const bindingFor = (binding: SearchCursorBinding) => ({ ...binding, operation: 'subjects.search.kinds' });
function encodeKindCursor(
  ring: KeyRing,
  binding: SearchCursorBinding,
  generation: number,
  digest: string,
  after: string,
  now: number,
) {
  return encodeSearchCursor(ring, bindingFor(binding), { generation, after: [digest, after] }, now);
}
async function decodeKindCursor(
  ring: KeyRing,
  binding: SearchCursorBinding,
  token: string,
  generation: number,
  digest: string,
  now: number,
): Promise<string> {
  const decoded = await decodeSearchCursor(ring, bindingFor(binding), token, now);
  if (!decoded.ok) {
    if (decoded.reason === 'expired') throw new ProblemError('search_restart_required');
    throw new ProblemError('invalid_request', { errors: [{ pointer: '/kindCursor', code: 'invalid_format' }] });
  }
  if (decoded.generation !== generation || decoded.after[0] !== digest)
    throw new ProblemError('search_restart_required');
  if (decoded.after.length !== 2 || typeof decoded.after[1] !== 'string')
    throw new ProblemError('invalid_request', { errors: [{ pointer: '/kindCursor', code: 'invalid_format' }] });
  return decoded.after[1];
}
