import { readFileSync } from 'node:fs';
import { OpenSearchError, SearchUnavailableError, type OpenSearch } from './opensearch.ts';

const PREFIX_PATTERN = /^[a-z0-9][a-z0-9-]{0,47}$/;
const definitionUrl = new URL('../../db/search/indices/subjects.json', import.meta.url);

export const SUBJECT_SORT_FORMAT = 1;

type SubjectIndexDefinition = Record<string, unknown>;
type ResolveIndexResponse = {
  indices: { name: string }[];
  aliases: { name: string; indices: string[] }[];
};

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

  const record = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value);
  const unavailable = () => new SearchUnavailableError('Subject generation mapping is missing or malformed');
  if (response.status !== 200 || !record(response.body)) throw unavailable();
  const indexMapping = response.body[index];
  if (!record(indexMapping) || !record(indexMapping.mappings)) throw unavailable();
  const mappings = indexMapping.mappings;
  if (!Object.hasOwn(mappings, '_meta')) return null;
  const meta = mappings._meta;
  if (!record(meta)) throw unavailable();
  const format = meta.name_sort_format;
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
  const response = await search.request<ResolveIndexResponse>('GET', `/_resolve/index/${prefix}subjects*`, undefined, {
    query: { expand_wildcards: 'all' },
  });
  const generationPattern = new RegExp(`^${prefix}subjects-g([1-9][0-9]*)$`);
  const generations = new Set<number>();
  for (const index of response.body.indices) {
    const match = generationPattern.exec(index.name);
    if (!match?.[1]) continue;
    const generation = Number(match[1]);
    if (Number.isSafeInteger(generation)) generations.add(generation);
  }

  const activeAlias = response.body.aliases.find((item) => item.name === alias);
  let active: number | null = null;
  if (activeAlias?.indices.length === 1) {
    const match = generationPattern.exec(activeAlias.indices[0] ?? '');
    const generation = match?.[1] ? Number(match[1]) : NaN;
    if (Number.isSafeInteger(generation)) active = generation;
  }

  return { generations: [...generations].sort((a, b) => a - b), active };
}
