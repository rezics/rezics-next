import {
  admitFilter,
  FilterError,
  parseFilter,
  positiveFilter,
  relationFacetProperty,
  type FilterRelease,
} from '@rezics/filter';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { systemClock, type KernelClock } from '../clock.ts';
import { GLOBAL_CONTEXT } from '../access/gates/catalogue.ts';
import { STANDARD_QUESTION_ID } from '../rating/votes.ts';
import { ProblemError, type FieldErrorCode } from '../http/problem.ts';
import { compileKinds, kindDigest, retainCurrent, type KindSnapshot } from './query.ts';
import { activeRelease } from '../semantic/definitions.ts';
import type { KeyRing } from '../tokens/seal.ts';
import {
  decodeSearchCursor,
  encodeSearchCursor,
  encodeRetainedSearchCursor,
  retainedSearchContinuation,
  type SearchCursorBinding,
  type SearchSortValue,
} from './cursor.ts';
import { validateRequestSourceSnapshot } from './request-source-snapshot.ts';
import { checkHits, type FactClause } from './disclosure/check.ts';
import { admitFacets, validateFacets, type FacetRequest } from './facets.ts';
import { compileFilter } from './filter.ts';
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
import { readSubjectSortFormat, SUBJECT_SORT_FORMAT, subjectGenerations, subjectIndexName } from './indices.ts';
import { OpenSearchError, SearchUnavailableError, type OpenSearch } from './opensearch.ts';
import { publicHitFigures } from './public-figures.ts';
import { installTemplates, searchSubjectHits, suggestSubjects, type SearchPlan } from './query.ts';
import { decodeRatingCursor, encodeRatingCursor, type RatingPhase } from './rating-cursor.ts';
import { normalizePublicRatingFigure, type PublicRatingEpoch, type PublicRatingSource } from './rating-source.ts';
import { subjectConsumer } from './runner.ts';
import { registerSearchScopeRuntime, createSearchScopeForService } from './service-scope.ts';
import type { RealmSubjectSource } from '../content/realm-subject-source.ts';
import type { RealmSubjectCapabilities } from './realm-scope.ts';
import type { LeafOptions } from '../semantic/scope-leaf-evidence.ts';
import { ScopeWork, scopeAllowance } from './scope-execution.ts';
import type { ScopeBasis } from './scope-source.ts';
import type { IndexedSubject, SubjectSource } from './source.ts';
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

export type SearchRequest = {
  text?: string;
  filter?: unknown;
  sort?: SearchPlan['sort'];
  population?: { realm: string };
  limit?: number;
  cursor?: string;
  kindCursor?: string;
  descriptions?: boolean;
  languages?: string[];
  properties?: string[];
};

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

  let filter;
  try {
    if (request.filter !== undefined) filter = parseFilter(request.filter);
  } catch (error) {
    if (error instanceof FilterError)
      throw new ProblemError(error.problem, {
        errors: error.errors.map(({ pointer, code }) => ({ pointer: `/filter${pointer}`, code })),
      });
    throw error;
  }

  const sort = request.sort === undefined ? (text ? 'relevance' : 'name') : request.sort;
  if (sort !== 'relevance' && sort !== 'name' && sort !== 'id' && sort !== 'collections' && sort !== 'rating')
    invalid('/sort', 'invalid_format');
  if (sort === 'relevance' && !text) unsupported('/sort');
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
    limit,
    hitOptions,
    // Keep the validated JSON, rather than the compiler's internal representation, in the binding.
    bindingRequest: {
      ...(text ? { text: request.text } : {}),
      ...(filter ? { filter } : {}),
      sort,
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
}) {
  const release =
    releaseOverride ?? (async () => ((await activeRelease(pool))?.release as FilterRelease | undefined) ?? null);
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
    filter: ReturnType<typeof parseFilter> | undefined,
    current?: FilterRelease,
    nativeOrder = false,
  ) {
    let admitted;
    if (filter) {
      const active = current ?? (await release());
      if (!active) throw new ProblemError('semantic_not_ready', { headers: { 'retry-after': '1' } });
      try {
        admitted = admitFilter(filter, active, containsOwnerPredicate(filter) ? { owner: true } : undefined);
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
      !(admitted && positiveFilter(admitted))
    )
      unsupported(text ? '/text' : '/filter');
    return admitted;
  }

  const service = {
    async search(
      principal: 'anonymous' | `account:${string}`,
      request: SearchRequest,
      now = clock().getTime(),
      active?: { digest: string; release: FilterRelease } | null,
      readContext?: PublicSearchReadContext,
    ) {
      request = ownSubjectRequest(request);
      const { text, filter, sort, limit, hitOptions, bindingRequest } = validate(request);
      // One lookup serves filter admission and the requested properties.
      const native = active === undefined && !releaseOverride ? await activeRelease(pool) : active;
      const current = native?.release ?? (releaseOverride ? await release() : undefined);
      if (publicFilters && !native) throw indexNotReady();
      const kinds: KindSnapshot | undefined = current
        ? compileKinds(current, native?.digest ?? kindDigest(current))
        : undefined;
      if ((filter || hitOptions.properties) && !current)
        throw new ProblemError('semantic_not_ready', { headers: { 'retry-after': '1' } });
      const admitted = await admitQuery(text, filter, current ?? undefined, request.population !== undefined);
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
        return response;
      }
      const scopedRequest = admitted !== undefined && containsOwnerPredicate(admitted);
      let scope: ReturnType<typeof createSearchScopeForService> | undefined;
      let preparedScope: Awaited<ReturnType<NonNullable<typeof scope>['prepare']>> | undefined;
      let scopeWork: ScopeWork | undefined;
      if (scopedRequest) {
        const options = readContext?.scope;
        if (!options) throw indexNotReady();
        scope = createSearchScopeForService(service, options);
        scopeWork = new ScopeWork(scopeAllowance(700, randomUUID()));
        const nativeOrder = !text && (sort === 'name' || sort === 'collections') ? sort : undefined;
        preparedScope = await sourceRequest(() =>
          scope!.prepare(admitted!, {
            releaseDigest: native?.digest ?? kindDigest(current!),
            ...(nativeOrder ? { nativeOrder, pageSize: limit } : {}),
            allowance: scopeWork!.remaining(),
          }),
        );
        scopeWork.native(scope.work(preparedScope));
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

      const compiledText = text ? compileText(text, { field: 'search_text', prefix: 't' }) : undefined;
      const compiledFilter =
        admitted && !preparedScope ? compileFilter(admitted, { prefix: 'f', relationOverflow: true }) : undefined;
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
            admitted && !preparedScope ? { filter: admitted, relationProperties } : undefined,
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
        return response;
      }
      const runtime = publicFilters?.();
      if (publicFilters && (!runtime || !readContext)) throw indexNotReady();
      const context = { deadline: readContext?.deadline ?? Date.now() + 10_000 };
      const capturePlan = {
        ...plan,
        generation,
        filterDocument: preparedScope ? undefined : admitted,
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

    async facets(
      principal: 'anonymous' | `account:${string}`,
      request: FacetRequest,
      now = clock().getTime(),
      context = { deadline: deadlineFor(30_000) },
    ): Promise<FacetDiscovery200Response> {
      request = ownSubjectRequest(request);
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
      read?: { deadline: number; complete(page: { subjects: Result[]; as_of: string }): Promise<void> },
    ) {
      languages = ownSubjectRequest(languages);
      if (typeof q !== 'string' || q.length > 128 || [...q].length < 1 || [...q].length > 64)
        invalid('/q', 'out_of_range');
      if (!Number.isInteger(limit) || limit < 1 || limit > 10) invalid('/limit', 'out_of_range');
      const options = validateHitOptions({ languages });
      const generation = await discoveryGeneration();
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
