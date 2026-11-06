import { MAX_SUBJECT_GENERATIONS } from './generation-limit.ts';
import { OpenSearchError, SearchUnavailableError, type OpenSearch } from './opensearch.ts';

export type PhysicalSubjectGeneration = Readonly<{
  physicalTarget: string;
  incarnation: string;
  consumerGeneration: string;
  generation: number;
}>;

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Parse live OpenSearch subject settings. Empty body is no retained generation.
 * Writer aliases, extra families and foreign names are ignored. Duplicate generations
 * with conflicting UUIDs, missing UUIDs or more than three subject generations are unresolved.
 */
export function physicalSubjectGenerationsFromSettings(
  prefix: string,
  body: unknown,
): PhysicalSubjectGeneration[] | null {
  if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(prefix) || !object(body)) return null;
  const pattern = new RegExp(`^${prefix}subjects-g([1-9][0-9]*)$`);
  const found: PhysicalSubjectGeneration[] = [];
  for (const [name, item] of Object.entries(body)) {
    const match = pattern.exec(name);
    if (!match?.[1] || match[0] !== name) continue;
    const settings = object(item) ? item.settings : null;
    const index = object(settings) ? settings.index : null;
    const uuid = object(index) ? index.uuid : null;
    if (typeof uuid !== 'string' || uuid.length === 0) return null;
    const generation = Number(match[1]);
    if (!Number.isSafeInteger(generation) || generation < 1) return null;
    const previous = found.find((row) => row.generation === generation);
    if (previous) {
      if (previous.incarnation !== uuid) return null;
      continue;
    }
    found.push({
      physicalTarget: name,
      incarnation: uuid,
      consumerGeneration: String(generation),
      generation,
    });
  }
  if (found.length > MAX_SUBJECT_GENERATIONS) return null;
  found.sort((a, b) => a.generation - b.generation);
  return found;
}

/** Live physical subject generations for one admitted prefix. `[]` is actual absence;
 * `null` is unresolved inventory (engine, UUID or cardinality).
 */
export async function listPhysicalSubjectGenerations(
  search: OpenSearch,
  prefix: string,
  options?: { timeoutMs?: number },
): Promise<PhysicalSubjectGeneration[] | null> {
  if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(prefix)) throw new TypeError('Invalid Search erasure prefix');
  let response: { status: number; body: unknown };
  try {
    response = await search.request('GET', `/${prefix}subjects-g*/_settings`, undefined, {
      query: { expand_wildcards: 'all', allow_no_indices: true, ignore_unavailable: true },
      ...(options?.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    });
  } catch (error) {
    if (error instanceof OpenSearchError && error.status === 404) return [];
    if (error instanceof OpenSearchError || error instanceof SearchUnavailableError) return null;
    throw error;
  }
  if (response.status !== 200) return null;
  return physicalSubjectGenerationsFromSettings(prefix, response.body);
}
