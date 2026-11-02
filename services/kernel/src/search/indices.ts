import { readFileSync } from 'node:fs';
import { OpenSearchError, SearchUnavailableError, type OpenSearch, type SearchRequestWork } from './opensearch.ts';
import { mixedDiscoveryIndexDefinition as nativeDiscoveryDefinition } from './discovery-documents.ts';

const PREFIX_PATTERN = /^[a-z0-9][a-z0-9-]{0,47}$/;
const definitionUrl = new URL('../../db/search/indices/subjects.json', import.meta.url);

export const SUBJECT_SORT_FORMAT = 1;
export const DISCOVERY_INDEX_FORMAT = 1;
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
  return createIndex(search, prefix, generation, subjectIndexDefinition());
}

/** Successor mapping in the same physical family; legacy Subject generations keep their format. */
export function discoveryIndexDefinition(): SubjectIndexDefinition {
  const result = structuredClone(subjectIndexDefinition());
  if (!record(result.mappings) || !record(result.mappings.properties) || !record(result.mappings._meta))
    throw new TypeError('Invalid base Search index definition');
  result.mappings._meta.discovery_format = DISCOVERY_INDEX_FORMAT;
  Object.assign(result.mappings.properties, {
    family: { type: 'keyword' },
    kind: { type: 'keyword' },
    identity: { type: 'keyword' },
    account_revision: { type: 'keyword' },
    active_handle: { type: 'keyword' },
  });
  return result;
}

/** Allocation only; source exhaustion, replay, exact-key reconciliation and custody precede activation. */
export async function createDiscoveryIndex(
  search: OpenSearch,
  prefix: string,
  generation: number,
  incarnation?: string,
): Promise<void> {
  const index = discoveryIndexName(prefix, generation);
  const definition = nativeDiscoveryDefinition();
  const response = await search.request<{ acknowledged?: boolean }>('PUT', `/${index}`, {
    ...definition,
    mappings: { ...definition.mappings, _meta: { ...definition.mappings._meta, incarnation } },
    aliases: { [`${index}-write`]: { is_write_index: true } },
  });
  if (response.body.acknowledged !== true)
    throw new SearchUnavailableError('Discovery allocation was not acknowledged');
}

export function discoveryIndexName(prefix: string, generation: number): string {
  validatePrefix(prefix);
  validateGeneration(generation);
  return `${prefix}discovery-g${generation}`;
}

export function discoveryAlias(prefix: string): string {
  validatePrefix(prefix);
  return `${prefix}discovery`;
}

export async function discoveryIndexUuid(search: OpenSearch, index: string, work?: SearchRequestWork): Promise<string> {
  const response = await search.request<unknown>('GET', `/${index}/_settings`, undefined, work ? { work } : undefined);
  const entry = record(response.body) ? response.body[index] : undefined;
  const settings = record(entry) ? entry.settings : undefined;
  const native = record(settings) ? settings.index : undefined;
  if (response.status !== 200 || !record(native) || typeof native.uuid !== 'string' || !native.uuid)
    throw new SearchUnavailableError('Discovery physical incarnation is missing');
  return native.uuid;
}

async function createIndex(
  search: OpenSearch,
  prefix: string,
  generation: number,
  body: SubjectIndexDefinition,
): Promise<void> {
  const index = subjectIndexName(prefix, generation);
  try {
    // Allocated atomically with the physical index; never recreate this alias on another incarnation.
    const writeAlias = `${index}-writer-${crypto.randomUUID().replaceAll('-', '')}`;
    await search.request('PUT', `/${index}`, { ...body, aliases: { [writeAlias]: { is_write_index: true } } });
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
    if (error instanceof OpenSearchError)
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
  work?: SearchRequestWork,
): Promise<{ generations: number[]; active: number | null }> {
  validatePrefix(prefix);
  const alias = subjectAlias(prefix);
  const unavailable = () => new SearchUnavailableError('Subject generation metadata is missing or malformed');
  let response: { status: number; body: unknown };
  try {
    response = await search.request('GET', `/_resolve/index/${prefix}subjects*`, undefined, {
      query: { expand_wildcards: 'all' },
      ...(work ? { work } : {}),
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
  // One public alias plus one allocator writer alias per observed generation.
  if (
    !Array.isArray(indices) ||
    indices.length > MAX_SUBJECT_GENERATIONS ||
    !Array.isArray(aliases) ||
    aliases.length > MAX_SUBJECT_GENERATIONS + 1 ||
    !Array.isArray(streams) ||
    streams.length !== 0
  )
    throw unavailable();
  const generationPattern = new RegExp(`^${prefix}subjects-g([1-9][0-9]*)$`);
  const writerPattern = new RegExp(`^${prefix}subjects-g([1-9][0-9]*)-writer-([a-f0-9]{32})$`);
  function generationOf(name: unknown): number {
    if (typeof name !== 'string' || name.length > alias.length + 2 + 16) throw unavailable();
    const match = generationPattern.exec(name);
    // `$` can match before a final line terminator; identity requires the whole name.
    if (!match?.[1] || match[0] !== name) throw unavailable();
    const generation = Number(match[1]);
    if (!Number.isSafeInteger(generation) || generation <= 0) throw unavailable();
    return generation;
  }
  function writerIndex(name: unknown): string | null {
    if (typeof name !== 'string' || name.length > alias.length + 2 + 16 + 8 + 32) return null;
    const match = writerPattern.exec(name);
    if (!match?.[1] || match[0] !== name) return null;
    const generation = Number(match[1]);
    if (!Number.isSafeInteger(generation) || generation <= 0) return null;
    return `${alias}-g${generation}`;
  }
  const generations = new Map<string, number>();
  const publicMembers = new Set<string>();
  const writerMembers = new Map<string, string>();
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
      (attributes.length === 2 && !attributes.includes('hidden')) ||
      Object.hasOwn(index, 'data_stream')
    )
      throw unavailable();
    if (Object.hasOwn(index, 'aliases')) {
      if (!Array.isArray(index.aliases) || index.aliases.length > 2) throw unavailable();
      const seen = new Set<string>();
      for (const entry of index.aliases) {
        if (typeof entry !== 'string' || seen.has(entry)) throw unavailable();
        seen.add(entry);
        if (entry === alias) {
          publicMembers.add(name);
          continue;
        }
        if (writerIndex(entry) === name && !writerMembers.has(name)) {
          writerMembers.set(name, entry);
          continue;
        }
        throw unavailable();
      }
    }
  }

  let active: number | null = null;
  const publicReceipts = new Set<string>();
  const writerReceipts = new Map<string, string>();
  const seenAliasNames = new Set<string>();
  for (const entry of aliases) {
    if (!record(entry) || typeof entry.name !== 'string' || seenAliasNames.has(entry.name)) throw unavailable();
    if (!Array.isArray(entry.indices) || entry.indices.length !== 1) throw unavailable();
    seenAliasNames.add(entry.name);
    const target: unknown = entry.indices[0];
    if (typeof target !== 'string' || !generations.has(target)) throw unavailable();
    if (entry.name === alias) {
      publicReceipts.add(target);
      continue;
    }
    if (writerIndex(entry.name) === target && writerMembers.get(target) === entry.name && !writerReceipts.has(target)) {
      writerReceipts.set(target, entry.name);
      continue;
    }
    throw unavailable();
  }
  if (publicReceipts.size !== publicMembers.size) throw unavailable();
  if (publicReceipts.size === 1) {
    const [target] = publicReceipts;
    if (!target || !publicMembers.has(target)) throw unavailable();
    active = generations.get(target)!;
  }
  if (writerReceipts.size !== writerMembers.size) throw unavailable();
  for (const [name, writer] of writerMembers) {
    if (writerReceipts.get(name) !== writer) throw unavailable();
  }

  return { generations: [...generations.values()].sort((a, b) => a - b), active };
}
