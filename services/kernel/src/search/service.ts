import type { Pool } from 'pg';
import { ProblemError, type FieldErrorCode } from '../http/problem.ts';
import type { KeyRing } from '../tokens/seal.ts';
import { decodeSearchCursor, encodeSearchCursor } from './cursor.ts';
import { checkHits, type FactClause } from './disclosure/check.ts';
import { compileFilter, FilterError, parseFilter, positiveFilter } from './filter.ts';
import { createFreshness } from './freshness.ts';
import { subjectGenerations, subjectIndexName } from './indices.ts';
import { OpenSearchError, SearchUnavailableError, type OpenSearch } from './opensearch.ts';
import { installTemplates, searchSubjects, suggestSubjects, type SearchPlan, type SubjectHit } from './query.ts';
import { subjectConsumer } from './runner.ts';
import type { IndexedSubject, SubjectSource } from './source.ts';
import { compileText, parseText, positiveText, TextSyntaxError } from './text.ts';

export type SearchRequest = {
  text?: string;
  filter?: unknown;
  sort?: SearchPlan['sort'];
  page_size?: number;
  page_token?: string;
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

function project(subject: IndexedSubject): Result {
  return {
    id: subject.id,
    type: subject.type,
    labels: Object.fromEntries(subject.labels.map(({ language, value }) => [language, value])),
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
  if ((text || filter) && !(text && positiveText(text)) && !(filter && positiveFilter(filter)))
    unsupported(text ? '/text' : '/filter');

  const sort = request.sort === undefined ? (text ? 'relevance' : 'name') : request.sort;
  if (sort !== 'relevance' && sort !== 'name' && sort !== 'id') invalid('/sort', 'invalid_format');
  if (sort === 'relevance' && !text) unsupported('/sort');
  const pageSize = request.page_size === undefined ? 20 : request.page_size;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 50) invalid('/page_size', 'out_of_range');

  return {
    text,
    filter,
    sort,
    pageSize,
    // Keep the validated JSON, rather than the compiler's internal representation, in the binding.
    bindingRequest: {
      ...(text ? { text: request.text } : {}),
      ...(filter ? { filter } : {}),
      sort,
      page_size: pageSize,
    },
  };
}

export function createSearchService({
  pool,
  client,
  prefix,
  source,
  cursors,
}: {
  pool: Pool;
  client: OpenSearch;
  prefix: string;
  source: SubjectSource;
  cursors: KeyRing;
}) {
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

  return {
    async search(principal: 'anonymous' | `account:${string}`, request: SearchRequest, now = Date.now()) {
      const { text, filter, sort, pageSize, bindingRequest } = validate(request);
      const binding = { operation: 'subjects.search', request: bindingRequest, principal };
      const cursor =
        request.page_token === undefined ? undefined : decodeSearchCursor(cursors, binding, request.page_token, now);
      if (cursor && !cursor.ok) {
        if (cursor.reason === 'expired') throw new ProblemError('search_restart_required');
        invalid('/page_token', 'invalid_format');
      }

      const compiledText = text ? compileText(text, { field: 'search_text', prefix: 't' }) : undefined;
      const compiledFilter = filter ? compileFilter(filter, { prefix: 'f' }) : undefined;
      const clauses = new Map<string, FactClause>(
        compiledFilter?.leaves.filter((leaf) => !leaf.negated).map((leaf) => [leaf.name, leaf]),
      );
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
        sort,
      };
      let after = cursor?.after;
      let generation = cursor?.generation;
      let total;
      let exhausted = false;
      const results: Result[] = [];
      for (let round = 0; round < 3; round++) {
        const size = Math.min(200, 2 * (pageSize - results.length) + 1);
        const page = await indexRequest(() =>
          searchSubjects(client, prefix, { ...plan, size, ...(after === undefined ? {} : { after }) }),
        );
        total ??= page.total;
        const currentGeneration = await generationOf(page.hits);
        if (generation !== undefined && generation !== currentGeneration)
          throw new ProblemError('search_restart_required');
        generation = currentGeneration;
        const { passed } = await checkHits(source, page.hits, clauses);
        const subjects = new Map(passed.map(({ hit, subject }) => [hit, subject]));
        let consumed = 0;
        for (const hit of page.hits) {
          after = hit.sort;
          consumed++;
          const subject = subjects.get(hit);
          if (subject) results.push(project(subject));
          if (results.length === pageSize) break;
        }
        exhausted = page.hits.length < size && consumed === page.hits.length;
        if (exhausted || results.length === pageSize) break;
      }
      return {
        results,
        total: total!,
        next_page_token: exhausted
          ? null
          : encodeSearchCursor(cursors, binding, { generation: generation!, after: after! }, now),
        as_of: await asOf(generation!),
      };
    },

    async suggest(q: string, limit = 8) {
      if (typeof q !== 'string' || q.length > 128 || [...q].length < 1 || [...q].length > 64)
        invalid('/q', 'out_of_range');
      if (!Number.isInteger(limit) || limit < 1 || limit > 10) invalid('/limit', 'out_of_range');
      const hits = await indexRequest(() => suggestSubjects(client, prefix, { text: q, size: 2 * limit }));
      const generation = await generationOf(hits);
      const { passed } = await checkHits(
        source,
        hits.map((hit) => ({ ...hit, matched: [] })),
        new Map(),
      );
      return { results: passed.slice(0, limit).map(({ subject }) => project(subject)), as_of: await asOf(generation) };
    },
  };
}
