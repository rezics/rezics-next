import {
  admitFilter,
  FilterError,
  parseFilter,
  positiveFilter,
  relationFacetProperty,
  type FilterRelease,
} from '@rezics/filter';
import type { Pool } from 'pg';
import { systemClock, type KernelClock } from '../clock.ts';
import { GLOBAL_CONTEXT } from '../access/gates/catalogue.ts';
import { STANDARD_QUESTION_ID } from '../rating/votes.ts';
import { ProblemError, type FieldErrorCode } from '../http/problem.ts';
import { activeRelease } from '../semantic/definitions.ts';
import type { KeyRing } from '../tokens/seal.ts';
import { decodeSearchCursor, encodeSearchCursor } from './cursor.ts';
import { checkHits, type FactClause } from './disclosure/check.ts';
import {
  admitFacets,
  codeFacet,
  discloseFacetValues,
  validateFacets,
  typeFacetLabels,
  type FacetRequest,
  type FacetValue,
} from './facets.ts';
import { compileFilter } from './filter.ts';
import { createFreshness } from './freshness.ts';
import { admitProperties, chooseTexts, projectFacts, projectHit, validateHitOptions, type SearchHit } from './hits.ts';
import { readSubjectSortFormat, SUBJECT_SORT_FORMAT, subjectGenerations } from './indices.ts';
import { OpenSearchError, SearchUnavailableError, type OpenSearch } from './opensearch.ts';
import { publicHitFigures } from './public-figures.ts';
import { countFacets, installTemplates, searchSubjects, suggestSubjects, type SearchPlan } from './query.ts';
import { decodeRatingCursor, encodeRatingCursor, type RatingPhase } from './rating-cursor.ts';
import { normalizePublicRatingFigure, type PublicRatingEpoch, type PublicRatingSource } from './rating-source.ts';
import { subjectConsumer } from './runner.ts';
import type { IndexedSubject, SubjectSource } from './source.ts';
import { compileText, parseText, positiveText, TextSyntaxError } from './text.ts';

export type SearchRequest = {
  text?: string;
  filter?: unknown;
  sort?: SearchPlan['sort'];
  limit?: number;
  cursor?: string;
  descriptions?: boolean;
  languages?: string[];
  properties?: string[];
};

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
    throw new ProblemError('semantic_not_ready', { headers: { 'retry-after': '1' } });
  }
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
  const limit = request.limit === undefined ? 20 : request.limit;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) invalid('/limit', 'out_of_range');
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
      limit,
      ...(hitOptions.descriptions ? { descriptions: true } : {}),
      ...(hitOptions.languages ? { languages: hitOptions.languages } : {}),
      ...(hitOptions.properties ? { properties: hitOptions.properties } : {}),
    },
  };
}

export function createSearchService({
  pool,
  client,
  prefix,
  source,
  ratings,
  cursors,
  clock = systemClock,
  facetSample = 10_000,
  // Definition releases store value.pattern on the property schema. Keep that object so pattern compilation stays cached.
  release = async () => ((await activeRelease(pool))?.release as FilterRelease | undefined) ?? null,
}: {
  pool: Pool;
  client: OpenSearch;
  prefix: string;
  source: SubjectSource;
  ratings?: PublicRatingSource;
  cursors: KeyRing;
  clock?: KernelClock;
  release?: () => Promise<FilterRelease | null>;
  facetSample?: number;
}) {
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
    hits: Awaited<ReturnType<typeof searchSubjects>>['hits'],
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
    let reader = freshness.get(generation);
    if (!reader) {
      reader = createFreshness(pool, subjectConsumer(prefix, generation));
      freshness.set(generation, reader);
    }
    return (await reader.current()).asOf.toISOString();
  }

  async function admitQuery(
    text: ReturnType<typeof parseText> | undefined,
    filter: ReturnType<typeof parseFilter> | undefined,
    current?: FilterRelease,
  ) {
    let admitted;
    if (filter) {
      const active = current ?? (await release());
      if (!active) throw new ProblemError('semantic_not_ready', { headers: { 'retry-after': '1' } });
      try {
        admitted = admitFilter(filter, active);
      } catch (error) {
        if (error instanceof FilterError)
          throw new ProblemError(error.problem, {
            errors: error.errors.map(({ pointer, code }) => ({ pointer: `/filter${pointer}`, code })),
          });
        throw error;
      }
    }
    if ((text || admitted) && !(text && positiveText(text)) && !(admitted && positiveFilter(admitted)))
      unsupported(text ? '/text' : '/filter');
    return admitted;
  }

  return {
    async search(principal: 'anonymous' | `account:${string}`, request: SearchRequest, now = clock().getTime()) {
      const { text, filter, sort, limit, hitOptions, bindingRequest } = validate(request);
      // One lookup serves filter admission and the requested properties.
      const current = filter || hitOptions.properties ? await release() : undefined;
      if ((filter || hitOptions.properties) && !current)
        throw new ProblemError('semantic_not_ready', { headers: { 'retry-after': '1' } });
      const admitted = await admitQuery(text, filter, current ?? undefined);
      if (hitOptions.properties) admitProperties(hitOptions.properties, current!);
      const binding = { operation: 'subjects.search', request: bindingRequest, principal };
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

      // Authenticate the original operation/request/viewer before reading dynamic rating metadata.
      const rating = sort === 'rating' ? await ratingEpoch() : undefined;
      let ratingPhase: RatingPhase | undefined;
      if (rating) {
        if (request.cursor !== undefined) {
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
      const format = await indexRequest(() => readSubjectSortFormat(client, prefix, generation));
      if (format !== SUBJECT_SORT_FORMAT) throw indexNotReady();

      const compiledText = text ? compileText(text, { field: 'search_text', prefix: 't' }) : undefined;
      const compiledFilter = admitted ? compileFilter(admitted, { prefix: 'f', relationOverflow: true }) : undefined;
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
      let after = cursor?.after;
      let overflow = false;
      let exhausted = false;
      const results: SearchHit[] = [];
      const shown: IndexedSubject[] = [];
      const emitted = new Set<string>();
      // Observe every checked snapshot, including rejected candidates: current overflow can
      // precede its indexed marker, so an exact candidate total would also be unsafe there.
      const sourcePositions = new Map<number, bigint>();
      const disclosureSource: SubjectSource =
        overflowProperties.length || rating
          ? {
              async read(partition, ids) {
                const snapshot = await source.read(partition, ids);
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
      for (let round = 0; round < 3; round++) {
        const size = Math.min(200, 2 * (limit - results.length) + 1);
        const page = await indexRequest(() =>
          searchSubjects(client, prefix, {
            ...plan,
            generation,
            size,
            ...(after === undefined ? {} : { after }),
            ...(rating ? { rating, ...(ratingPhase ? { ratingPhase } : {}) } : {}),
          }),
        );
        overflow ||= page.overflow === true;
        sourcePositions.clear();
        const { passed, relationRejected } = await sourceRequest(() =>
          checkHits(
            disclosureSource,
            page.hits,
            clauses,
            admitted ? { filter: admitted, relationProperties } : undefined,
          ),
        );
        inexact ||= relationRejected === true;
        const ratingAccepted = rating ? await ratingCandidates(page.hits, rating, sourcePositions) : undefined;
        const subjects = new Map(
          passed
            .filter(({ hit }) => !ratingAccepted || ratingAccepted.has(hit))
            .map(({ hit, subject }) => [hit, subject]),
        );
        let consumed = 0;
        for (const hit of page.hits) {
          const subject = emitted.has(hit.id) ? undefined : subjects.get(hit);
          // Consume rejected lookahead too, stopping before the next undisclosed hit.
          if (results.length === limit && subject) break;
          after = hit.sort;
          if (rating) {
            if (hit.ratingPhase !== 'scored' && hit.ratingPhase !== 'unscored') throw indexNotReady();
            ratingPhase = hit.ratingPhase;
          }
          consumed++;
          if (subject) {
            emitted.add(hit.id);
            results.push(projectHit(subject, hitOptions));
            shown.push(subject);
          }
        }
        exhausted = page.hits.length < size && consumed === page.hits.length;
        if (exhausted || results.length === limit) break;
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
      const response = {
        subjects: publicResults,
        next: exhausted
          ? null
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
      if ((await indexRequest(freshAliasGeneration)) !== generation) throw new ProblemError('search_restart_required');
      return response;
    },

    async facets(
      principal: 'anonymous' | `account:${string}`,
      request: FacetRequest & { languages?: string[] },
      now = clock().getTime(),
    ) {
      const { languages: languageChain, ...facetRequest } = request;
      const { languages } = validateHitOptions({ languages: languageChain });
      const facets = validateFacets(facetRequest);
      const { text, filter } = validate({
        ...(request.text === undefined ? {} : { text: request.text }),
        filter: request.filter,
      });
      const current = await release();
      if (!current) throw new ProblemError('semantic_not_ready', { headers: { 'retry-after': '1' } });
      const admitted = await admitQuery(text, filter, current);
      admitFacets(facets, filter, current);
      const compiledFilter = admitted ? compileFilter(admitted, { prefix: 'f', relationOverflow: true }) : undefined;
      const overflowProperties = [
        ...new Set(compiledFilter?.leaves.flatMap((leaf) => (leaf.facet === 'statement' ? [leaf.property] : []))),
      ];
      const generation = await discoveryGeneration();
      const counted = await indexRequest(() =>
        countFacets(client, prefix, {
          generation,
          ...(text ? { query: compileText(text, { field: 'search_text', prefix: 't' }).query } : {}),
          ...(compiledFilter ? { filter: compiledFilter.query } : {}),
          ...(overflowProperties.length ? { overflowProperties } : {}),
          facets,
          sample: facetSample,
        }),
      );
      const coded = new Set(
        facets.filter((facet) => codeFacet(current, facet.property)).map((facet) => facet.property),
      );
      const subjects = await sourceRequest(() =>
        discloseFacetValues(
          source,
          counted.facets.flatMap((facet) =>
            facet.property === 'type' || coded.has(facet.property) ? [] : facet.values.map(({ value }) => value),
          ),
        ),
      );
      const response = {
        facets: counted.facets.map((facet, index) => ({
          property: facet.property,
          values: facet.values
            .flatMap(({ value }): Omit<FacetValue, 'count'>[] => {
              if (facet.property === 'type') {
                const available = typeFacetLabels(current, value);
                const labels =
                  available && languages
                    ? chooseTexts(
                        Object.entries(available).map(([language, text]) => ({ language, value: text })),
                        languages,
                        undefined,
                      )
                    : available;
                return labels ? [{ value, labels }] : [];
              }
              if (coded.has(facet.property)) return [{ value, labels: {} }];
              const subject = subjects.get(value);
              return subject ? [{ value, labels: project(subject, languages).labels }] : [];
            })
            .slice(0, facets[index]!.size),
        })),
        as_of: await asOf(generation),
      };
      if ((await indexRequest(freshAliasGeneration)) !== generation) throw new ProblemError('search_restart_required');
      return response;
    },

    async suggest(q: string, limit = 8, languages?: string[]) {
      if (typeof q !== 'string' || q.length > 128 || [...q].length < 1 || [...q].length > 64)
        invalid('/q', 'out_of_range');
      if (!Number.isInteger(limit) || limit < 1 || limit > 10) invalid('/limit', 'out_of_range');
      const options = validateHitOptions({ languages });
      const generation = await discoveryGeneration();
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
      if ((await indexRequest(freshAliasGeneration)) !== generation) throw new ProblemError('search_restart_required');
      return response;
    },
  };
}
