import { readFileSync } from 'node:fs';
import { OpenSearchError, type OpenSearch } from './opensearch.ts';

const PREFIX_PATTERN = /^[a-z0-9][a-z0-9-]{0,47}$/;
const definitionUrl = new URL('../../db/search/indices/subjects.json', import.meta.url);

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
