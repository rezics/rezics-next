import { readFileSync } from 'node:fs';
import { OpenSearchError, SearchUnavailableError, type OpenSearch } from './opensearch.ts';

const PREFIX_PATTERN = /^[a-z0-9][a-z0-9-]{0,47}$/;
const definitionUrl = new URL('../../db/search/indices/subjects.json', import.meta.url);

export const SUBJECT_SORT_FORMAT = 1;
export const MAX_SUBJECT_GENERATIONS = 3;

type SubjectIndexDefinition = Record<string, unknown>;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

let definition: SubjectIndexDefinition | undefined;

function validatePrefix(prefix: string): void {
  if (!PREFIX_PATTERN.test(prefix)) throw new RangeError('Invalid subject index prefix');
}

function validateGeneration(generation: number): void {
  if (!Number.isSafeInteger(generation) || generation <= 0) throw new RangeError('Invalid subject index generation');
}

export function subjectIndexName(prefix: string, generation: number): string {
  validatePrefix(prefix);
  validateGeneration(generation);
  return `${prefix}subjects-g${generation}`;
}

export function subjectAlias(prefix: string): string {
  validatePrefix(prefix);
  return `${prefix}subjects`;
}

export function subjectIndexDefinition(): SubjectIndexDefinition {
  if (definition === undefined) {
    definition = JSON.parse(readFileSync(definitionUrl, 'utf8')) as SubjectIndexDefinition;
  }
  return definition;
}

export async function createSubjectIndex(search: OpenSearch, prefix: string, generation: number): Promise<void> {
  const index = subjectIndexName(prefix, generation);
  try {
    await search.request('PUT', `/${index}`, subjectIndexDefinition());
  } catch (error) {
    if (error instanceof OpenSearchError && error.type === 'resource_already_exists_exception') return;
    throw error;
  }
}

/** Read the bounded name-sort writer format from one physical generation's native mapping metadata. */
export async function readSubjectSortFormat(
  search: OpenSearch,
  prefix: string,
  generation: number,
): Promise<number | null> {
  const index = subjectIndexName(prefix, generation);
  let response: { status: number; body: unknown };
  try {
    response = await search.request('GET', `/${index}/_mapping`);
  } catch (error) {
    if (error instanceof OpenSearchError && error.type === 'index_not_found_exception')
      throw new SearchUnavailableError('Subject generation mapping is unavailable', { cause: error });
    throw error;
  }

  const unavailable = () => new SearchUnavailableError('Subject generation mapping is missing or malformed');
  if (!record(response) || response.status !== 200 || !record(response.body)) throw unavailable();
  // A concrete mapping request must describe exactly that physical generation.
  const names = Object.keys(response.body);
  if (names.length !== 1 || names[0] !== index) throw unavailable();
  const indexMapping = response.body[index];
  if (!record(indexMapping) || !record(indexMapping.mappings) || !record(indexMapping.mappings.properties))
    throw unavailable();
  const mappings = indexMapping.mappings;
  if (!Object.hasOwn(mappings, '_meta')) return null;
  const meta = mappings._meta;
  if (!record(meta)) throw unavailable();
  if (!Object.hasOwn(meta, 'name_sort_format')) return null;
  const format = meta.name_sort_format;
  if (typeof format !== 'number' || !Number.isSafeInteger(format) || format < 0) throw unavailable();
  return format === SUBJECT_SORT_FORMAT ? SUBJECT_SORT_FORMAT : null;
}

/** Add rating sort fields to an existing generation without changing its analyzers or sort-key bounds. */
export async function ensureSubjectRatingMapping(
  search: OpenSearch,
  prefix: string,
  generation: number,
): Promise<void> {
  const index = subjectIndexName(prefix, generation);
  await search.request('PUT', `/${index}/_mapping`, {
    properties: {
      rating_score: { type: 'double', doc_values: true, coerce: false },
      rating_prior_epoch: { type: 'long', doc_values: true, coerce: false },
    },
  });
}

export async function subjectGenerations(
  search: OpenSearch,
  prefix: string,
): Promise<{ generations: number[]; active: number | null }> {
  validatePrefix(prefix);
  const alias = subjectAlias(prefix);
  const unavailable = () => new SearchUnavailableError('Subject generation metadata is missing or malformed');
  let response: { status: number; body: unknown };
  try {
    response = await search.request('GET', `/_resolve/index/${prefix}subjects*`, undefined, {
      query: { expand_wildcards: 'all' },
    });
  } catch (error) {
    if (error instanceof OpenSearchError)
      throw new SearchUnavailableError('Subject generation metadata is unavailable', { cause: error });
    throw error;
  }
  if (!record(response) || response.status !== 200 || !record(response.body)) throw unavailable();
  if (Object.hasOwn(response.body, 'error')) throw unavailable();
  const { indices, aliases, data_streams: streams } = response.body;
  // Check cardinality before visiting records. The generation limit also bounds
  // duplicate/foreign receipts; deduplication must never hide an oversized set.
  if (
    !Array.isArray(indices) ||
    indices.length > MAX_SUBJECT_GENERATIONS ||
    !Array.isArray(aliases) ||
    aliases.length > 1 ||
    !Array.isArray(streams) ||
    streams.length !== 0
  )
    throw unavailable();
  const generationPattern = new RegExp(`^${prefix}subjects-g([1-9][0-9]*)$`);
  function generationOf(name: unknown): number {
    if (typeof name !== 'string' || name.length > alias.length + 2 + 16) throw unavailable();
    const match = generationPattern.exec(name);
    if (!match?.[1]) throw unavailable();
    const generation = Number(match[1]);
    if (!Number.isSafeInteger(generation) || generation <= 0) throw unavailable();
    return generation;
  }
  const generations = new Map<string, number>();
  const aliased = new Set<string>();
  for (const index of indices) {
    if (!record(index)) throw unavailable();
    const generation = generationOf(index.name);
    const name = index.name as string;
    if (generations.has(name)) throw unavailable();
    generations.set(name, generation);
    // OpenSearch emits attributes even when it omits an empty aliases field.
    // Hidden open indices remain readable; closed/frozen/data-stream indices
    // are not subject generations supported by this writer/query lifecycle.
    const attributes = index.attributes;
    if (
      !Array.isArray(attributes) ||
      attributes.length < 1 ||
      attributes.length > 2 ||
      !attributes.includes('open') ||
      attributes.some((value) => value !== 'open' && value !== 'hidden') ||
      new Set(attributes).size !== attributes.length ||
      Object.hasOwn(index, 'data_stream')
    )
      throw unavailable();
    if (Object.hasOwn(index, 'aliases')) {
      if (!Array.isArray(index.aliases) || index.aliases.length > 1) throw unavailable();
      if (index.aliases.length === 1) {
        if (index.aliases[0] !== alias) throw unavailable();
        aliased.add(name);
      }
    }
  }

  let active: number | null = null;
  if (aliases.length === 1) {
    const entry: unknown = aliases[0];
    if (!record(entry) || entry.name !== alias || !Array.isArray(entry.indices) || entry.indices.length !== 1)
      throw unavailable();
    const target: unknown = entry.indices[0];
    const generation = generationOf(target);
    if (typeof target !== 'string' || !generations.has(target) || aliased.size !== 1 || !aliased.has(target))
      throw unavailable();
    active = generation;
  } else if (aliased.size !== 0) {
    throw unavailable();
  }

  return { generations: [...generations.values()].sort((a, b) => a - b), active };
}
