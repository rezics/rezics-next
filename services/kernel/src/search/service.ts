import {
  admitFilter,
  FilterError,
  parseFilter,
  positiveFilter,
  relationFacetProperty,
  type FilterRelease,
} from '@rezics/filter';
import type { Pool } from 'pg';
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
import { subjectGenerations, subjectIndexName } from './indices.ts';
import { OpenSearchError, SearchUnavailableError, type OpenSearch } from './opensearch.ts';
import {
  countFacets,
  installTemplates,
  searchSubjects,
  suggestSubjects,
  type SearchPlan,
  type SubjectHit,
} from './query.ts';
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
  if (sort !== 'relevance' && sort !== 'name' && sort !== 'id' && sort !== 'collections')
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
  cursors,
  facetSample = 10_000,
  // Definition releases store value.pattern on the property schema. Keep that object so pattern compilation stays cached.
  release = async () => ((await activeRelease(pool))?.release as FilterRelease | undefined) ?? null,
}: {
  pool: Pool;
  client: OpenSearch;
  prefix: string;
  source: SubjectSource;
  cursors: KeyRing;
  release?: () => Promise<FilterRelease | null>;
  facetSample?: number;
}) {
  if (!Number.isSafeInteger(facetSample) || facetSample < 1)
    throw new RangeError('facetSample must be a positive safe integer');
  let templates: Promise<void> | undefined;
  let alias: { generation: number; expiresAt: number } | undefined;
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

  function aliasGeneration(): Promise<number> {
    if (aliasRead) return aliasRead;
    if (alias && Date.now() < alias.expiresAt) return Promise.resolve(alias.generation);
    const read = subjectGenerations(client, prefix)
      .then(({ active }) => {
        if (active === null) throw indexNotReady();
        alias = { generation: active, expiresAt: Date.now() + 1000 };
        return active;
      })
      .finally(() => {
        if (aliasRead === read) aliasRead = undefined;
      });
    aliasRead = read;
    return read;
  }

  async function generationOf(hits: readonly SubjectHit[]): Promise<number> {
    if (!hits.length) return indexRequest(aliasGeneration);
    let generation: number | undefined;
    const stem = `${prefix}subjects-g`;
    for (const hit of hits) {
      const suffix = hit.index.startsWith(stem) ? hit.index.slice(stem.length) : '';
      const value = Number(suffix);
      if (!Number.isSafeInteger(value) || value < 1 || subjectIndexName(prefix, value) !== hit.index)
        throw indexNotReady();
      if (generation !== undefined && value !== generation) throw new ProblemError('search_restart_required');
      generation = value;
    }
    return generation!;
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
    async search(principal: 'anonymous' | `account:${string}`, request: SearchRequest, now = Date.now()) {
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
      let cursor = request.cursor === undefined ? undefined : decodeSearchCursor(cursors, binding, request.cursor, now);
      if (cursor && !cursor.ok && cursor.reason === 'invalid') {
        cursor = decodeSearchCursor(cursors, lowerBoundBinding, request.cursor!, now);
        inexact = cursor.ok;
      }
      if (cursor && !cursor.ok) {
        if (cursor.reason === 'expired') throw new ProblemError('search_restart_required');
        invalid('/cursor', 'invalid_format');
      }

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
      let generation = cursor?.generation;
      let total;
      let overflow = false;
      let exhausted = false;
      const results: SearchHit[] = [];
      const shown: IndexedSubject[] = [];
      // Observe every checked snapshot, including rejected candidates: current overflow can
      // precede its indexed marker, so an exact candidate total would also be unsafe there.
      const disclosureSource: SubjectSource = overflowProperties.length
        ? {
            async read(partition, ids) {
              const snapshot = await source.read(partition, ids);
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
          searchSubjects(client, prefix, { ...plan, size, ...(after === undefined ? {} : { after }) }),
        );
        total ??= page.total;
        overflow ||= page.overflow === true;
        const currentGeneration = await generationOf(page.hits);
        if (generation !== undefined && generation !== currentGeneration)
          throw new ProblemError('search_restart_required');
        generation = currentGeneration;
        const { passed, relationRejected } = await sourceRequest(() =>
          checkHits(
            disclosureSource,
            page.hits,
            clauses,
            admitted ? { filter: admitted, relationProperties } : undefined,
          ),
        );
        inexact ||= relationRejected === true;
        const subjects = new Map(passed.map(({ hit, subject }) => [hit, subject]));
        let consumed = 0;
        for (const hit of page.hits) {
          const subject = subjects.get(hit);
          // Consume rejected lookahead too, stopping before the next undisclosed hit.
          if (results.length === limit && subject) break;
          after = hit.sort;
          consumed++;
          if (subject) {
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
      return {
        subjects: results,
        // Overflow and live rejections make candidate totals unsafe. Only disclosed hits
        // on this response prove a count without scanning beyond the bounded pages.
        total: overflow || inexact ? { value: results.length, relation: 'lower_bound' as const } : total!,
        next: exhausted
          ? null
          : encodeSearchCursor(
              cursors,
              overflow || inexact ? lowerBoundBinding : binding,
              { generation: generation!, after: after! },
              now,
            ),
        as_of: await asOf(generation!),
      };
    },

    async facets(
      principal: 'anonymous' | `account:${string}`,
      request: FacetRequest & { languages?: string[] },
      now = Date.now(),
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
      const counted = await indexRequest(() =>
        countFacets(client, prefix, {
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
      return {
        facets: counted.facets.map((facet, index) => ({
          property: facet.property,
          relation: facet.relation,
          values: facet.values
            .flatMap(({ value, count }): FacetValue[] => {
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
                return labels ? [{ value, count, labels }] : [];
              }
              if (coded.has(facet.property)) return [{ value, count, labels: {} }];
              const subject = subjects.get(value);
              return subject ? [{ value, count, labels: project(subject, languages).labels }] : [];
            })
            .slice(0, facets[index]!.size),
        })),
        total: counted.total,
        as_of: await asOf(await indexRequest(aliasGeneration)),
      };
    },

    async suggest(q: string, limit = 8, languages?: string[]) {
      if (typeof q !== 'string' || q.length > 128 || [...q].length < 1 || [...q].length > 64)
        invalid('/q', 'out_of_range');
      if (!Number.isInteger(limit) || limit < 1 || limit > 10) invalid('/limit', 'out_of_range');
      const options = validateHitOptions({ languages });
      const hits = await indexRequest(() => suggestSubjects(client, prefix, { text: q, size: 2 * limit }));
      const generation = await generationOf(hits);
      const { passed } = await sourceRequest(() =>
        checkHits(
          source,
          hits.map((hit) => ({ ...hit, matched: [] })),
          new Map(),
        ),
      );
      return {
        subjects: passed.slice(0, limit).map(({ subject }) => project(subject, options.languages)),
        as_of: await asOf(generation),
      };
    },
  };
}
