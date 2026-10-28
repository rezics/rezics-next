import { admitFilter, FilterError, type FilterDocument, type FilterRelease } from '@rezics/filter';
import { ProblemError, type FieldErrorCode } from '../http/problem.ts';
import { subjectPartition, type IndexedSubject, type SubjectSource } from './source.ts';

export type FacetRequest = {
  text?: string;
  filter?: unknown;
  facets: { property: string; size?: number }[];
};

export type Facet = { property: string; size: number };
export type FacetValue = { value: string; count: number; labels: Record<string, string> };

function ownField(input: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  if (!descriptor || !Object.hasOwn(descriptor, 'value')) return undefined;
  return descriptor.value;
}

function isRecord(value: unknown): value is object {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** A string facet whose definition declares `value.pattern`. Its values are codes, not subjects. */
export function codeFacet(release: FilterRelease, property: string): boolean {
  if (!isRecord(release)) return false;
  const properties = ownField(release, 'properties');
  if (!isRecord(properties)) return false;
  const definition = ownField(properties, property);
  if (!isRecord(definition) || ownField(definition, 'datatype') !== 'string') return false;
  const value = ownField(definition, 'value');
  if (!isRecord(value)) return false;
  const pattern = ownField(value, 'pattern');
  return typeof pattern === 'string' && pattern.length > 0;
}

/** Type definitions are public; their labels need no subject disclosure. */
export function typeFacetLabels(release: FilterRelease, type: string): Record<string, string> | undefined {
  const definition = ownField(release.types, type);
  if (!isRecord(definition)) return undefined;
  const labels = ownField(definition, 'labels');
  // FilterRelease only describes fields used for admission; definition releases also carry label maps.
  return isRecord(labels) ? (labels as Record<string, string>) : {};
}

function invalid(pointer: string, code: FieldErrorCode): never {
  throw new ProblemError('invalid_request', { errors: [{ pointer, code }] });
}

function closed(input: unknown, fields: string[], pointer: string): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) invalid(pointer, 'invalid_type');
  for (const key of Object.keys(input)) {
    if (!fields.includes(key)) invalid(`${pointer}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`, 'unknown_field');
  }
  return input as Record<string, unknown>;
}

export function validateFacets(request: FacetRequest): Facet[] {
  const body = closed(request, ['text', 'filter', 'facets'], '');
  if (body.facets === undefined) invalid('/facets', 'required');
  if (!Array.isArray(body.facets)) invalid('/facets', 'invalid_type');
  if (body.facets.length < 1 || body.facets.length > 8) invalid('/facets', 'out_of_range');
  const properties = new Set<string>();
  return Array.from(body.facets, (entry: unknown, index) => {
    const pointer = `/facets/${index}`;
    const facet = closed(entry, ['property', 'size'], pointer);
    if (facet.property === undefined) invalid(`${pointer}/property`, 'required');
    if (typeof facet.property !== 'string') invalid(`${pointer}/property`, 'invalid_type');
    if (properties.has(facet.property)) invalid(`${pointer}/property`, 'invalid_format');
    properties.add(facet.property);
    const size = facet.size === undefined ? 10 : facet.size;
    if (typeof size !== 'number' || !Number.isInteger(size) || size < 1 || size > 20)
      invalid(`${pointer}/size`, 'out_of_range');
    return { property: facet.property, size };
  });
}

/** Probe admission with the same immediate type anchors, without spending the query's leaf/depth budget. */
export function admitFacets(facets: readonly Facet[], filter: FilterDocument | undefined, release: FilterRelease) {
  let types: string[] | undefined;
  for (const node of filter && 'and' in filter ? filter.and : filter ? [filter] : []) {
    const expanded = 'saved' in node ? admitFilter(node, release) : node;
    if ('type' in expanded)
      types = types === undefined ? [...expanded.type.in] : types.filter((type) => expanded.type.in.includes(type));
  }
  for (const [index, facet] of facets.entries()) {
    if (facet.property === 'type') continue;
    if (types?.length === 0)
      throw new ProblemError('unsupported_query', {
        errors: [{ pointer: `/facets/${index}/property`, code: 'unsupported' }],
      });
    try {
      admitFilter(
        {
          and: [
            ...(types ? [{ type: { in: types } }] : []),
            { statement: { property: facet.property, in: ['00000000-0000-0000-0000-000000000000'] } },
          ],
        },
        release,
      );
    } catch (error) {
      if (!(error instanceof FilterError)) throw error;
      // The item probe is not a code. A registered code facet rejects that probe as invalid_format.
      const codeProbe =
        codeFacet(release, facet.property) &&
        error.problem === 'invalid_request' &&
        error.errors.length > 0 &&
        error.errors.every((item) => item.code === 'invalid_format');
      if (codeProbe) continue;
      throw new ProblemError('unsupported_query', {
        errors: [{ pointer: `/facets/${index}/property`, code: 'unsupported' }],
      });
    }
  }
}

/** Read each value anchor once, grouping across all facets before applying disclosure. */
export async function discloseFacetValues(source: SubjectSource, values: readonly string[]) {
  const groups = new Map<number, Set<string>>();
  for (const value of values) {
    let partition: number;
    try {
      partition = subjectPartition(value);
    } catch {
      continue;
    }
    let ids = groups.get(partition);
    if (!ids) groups.set(partition, (ids = new Set()));
    ids.add(value);
  }
  const visible = new Map<string, IndexedSubject>();
  const partitions = [...groups].map(([partition, ids]) => ({
    partition,
    chunks: Array.from({ length: Math.ceil(ids.size / 256) }, (_, index) =>
      [...ids].slice(index * 256, (index + 1) * 256),
    ),
  }));
  let next = 0;
  async function worker() {
    while (next < partitions.length) {
      const home = partitions[next++];
      if (!home) return;
      for (const chunk of home.chunks) {
        const requested = new Set(chunk);
        const snapshot = await source.read(home.partition, chunk);
        for (const subject of snapshot.subjects) {
          if (requested.has(subject.id) && subject.visibility === 'visible' && subject.redirect === null)
            visible.set(subject.id, subject);
        }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(8, partitions.length) }, () => worker()));
  return visible;
}
