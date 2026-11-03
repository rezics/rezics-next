import { admitFilter, facetProperties, FILTER_LIMITS, type FilterDocument, type FilterRelease } from '@rezics/filter';

export type CollectionFilterParams = {
  selected: Record<string, string[]>;
  selectedLabels: Record<string, string>;
  ranges: Record<string, { from?: number; to?: number }>;
  ignored: string[];
  document?: FilterDocument;
  issues?: { key: string; reason: 'limit' | 'ambiguous' | 'invalid' }[];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Parse readable f.<property> and r.<property>=from,to address parameters, then admit the closed document. */
export function readCollectionFilterParams(
  params: URLSearchParams,
  release: FilterRelease,
  type: string,
): CollectionFilterParams {
  const selected: Record<string, string[]> = {};
  const selectedLabels: Record<string, string> = {};
  const ranges: CollectionFilterParams['ranges'] = {};
  const ignored: string[] = [];
  const issues: NonNullable<CollectionFilterParams['issues']> = [];
  const reject = (key: string, reason: NonNullable<CollectionFilterParams['issues']>[number]['reason']) => {
    ignored.push(key);
    issues.push({ key, reason });
  };
  const facets = facetProperties(release, [type]);
  const labels = new Map(
    [...params].filter(([key]) => key.startsWith('l.')).map(([key, value]) => [key.slice(2), value]),
  );
  const clauses: FilterDocument[] = [];
  for (const [key, values] of groupParams(params)) {
    if (key === 'type') continue;
    if (key.startsWith('l.')) continue;
    if (!/^[fr]\./.test(key)) continue;
    const match = /^(f|r)\.(.+)$/.exec(key);
    if (!match || !facets.includes(match[2]!)) {
      reject(key, 'invalid');
      continue;
    }
    const property = match[2]!;
    const definition = release.properties[property];
    if (!definition) {
      reject(key, 'invalid');
      continue;
    }
    if (
      match[1] === 'f' &&
      (definition.datatype === 'wikibase-item' ||
        (definition.datatype === 'string' && Boolean(definition.value?.pattern)))
    ) {
      // Count the complete request before deduplication, just like native `in` admission.
      if (values.length > FILTER_LIMITS.in) {
        reject(key, 'limit');
        continue;
      }
      let accepted: string[];
      try {
        admitFilter({ statement: { property, in: values } }, release);
        accepted = [...new Set(values)];
      } catch {
        reject(key, 'invalid');
        continue;
      }
      if (accepted.length) {
        selected[property] = accepted;
        const label = labels.get(property);
        if (label && label.length <= 160) selectedLabels[property] = label;
        clauses.push({ statement: { property, in: accepted } });
      }
      continue;
    }
    if (match[1] === 'r' && ['quantity', 'time'].includes(definition.datatype)) {
      if (values.length !== 1) {
        reject(key, 'ambiguous');
        continue;
      }
      const [fromText, toText, ...extra] = values[0]!.split(',');
      const from = fromText ? Number(fromText) : undefined;
      const to = toText ? Number(toText) : undefined;
      if (
        extra.length ||
        (from !== undefined && !Number.isFinite(from)) ||
        (to !== undefined && !Number.isFinite(to)) ||
        (from === undefined && to === undefined) ||
        (from !== undefined && to !== undefined && from > to)
      ) {
        reject(key, 'invalid');
        continue;
      }
      if (
        definition.datatype === 'time' &&
        [from, to].some((bound) => bound !== undefined && !Number.isSafeInteger(bound))
      ) {
        reject(key, 'invalid');
        continue;
      }
      const unit = definition.datatype === 'quantity' ? definition.units?.[0] : undefined;
      if (definition.datatype === 'quantity' && !unit) {
        reject(key, 'invalid');
        continue;
      }
      const range = {
        ...(from === undefined ? {} : { gte: from }),
        ...(to === undefined ? {} : { lte: to }),
        ...(unit ? { unit } : {}),
      };
      try {
        const clause = { statement: { property, range } } as FilterDocument;
        admitFilter(clause, release);
        ranges[property] = { ...(from === undefined ? {} : { from }), ...(to === undefined ? {} : { to }) };
        clauses.push(clause);
      } catch {
        reject(key, 'invalid');
      }
      continue;
    }
    reject(key, 'invalid');
  }
  // Keep complete accepted groups available for an explicit correction, never for a partial read.
  const state = { selected, selectedLabels, ranges, ignored, issues };
  if (issues.length || clauses.length === 0) return state;
  try {
    const document = admitFilter(clauses.length === 1 ? clauses[0]! : { and: clauses }, release);
    return { ...state, document };
  } catch {
    reject('filter', 'invalid');
    return { selected: {}, selectedLabels: {}, ranges: {}, ignored, issues };
  }
}

function groupParams(params: URLSearchParams): [string, string[]][] {
  const grouped = new Map<string, string[]>();
  for (const [key, value] of params) {
    const values = grouped.get(key) ?? [];
    values.push(value);
    grouped.set(key, values);
  }
  return [...grouped];
}

/** The single transport adapter for the admitted filter on a Collection members read. */
export function collectionFilterQuery(document: FilterDocument | undefined): { filter?: string } {
  return document ? { filter: JSON.stringify(document) } : {};
}

export function collectionFilterAddress(
  locale: string,
  id: string,
  selected: Record<string, string[]>,
  ranges: CollectionFilterParams['ranges'],
  selectedLabels: Record<string, string> = {},
  type?: string,
  context?: URLSearchParams,
): string {
  const params = new URLSearchParams(context);
  // Rebuild only filter fields; unrelated display and navigation context survives.
  for (const key of [...params.keys()]) if (key === 'type' || /^[frl]\./.test(key)) params.delete(key);
  if (type) params.set('type', type);
  for (const [property, values] of Object.entries(selected))
    for (const value of values) params.append(`f.${property}`, value);
  for (const [property, label] of Object.entries(selectedLabels))
    if (selected[property]?.length && label) params.set(`l.${property}`, label);
  for (const [property, range] of Object.entries(ranges))
    params.set(`r.${property}`, `${range.from ?? ''},${range.to ?? ''}`);
  const predicate = (value: URLSearchParams) =>
    JSON.stringify(
      [...new Set(['type', ...value.keys()])]
        .filter((key) => key === 'type' || /^[fr]\./.test(key))
        .sort()
        .map((key) => {
          if (key === 'type') return [key, value.getAll(key).length ? value.getAll(key) : ['schema:Book']];
          if (key.startsWith('r.'))
            return [
              key,
              value.getAll(key).map((range) => {
                const [from, to, ...extra] = range.split(',');
                const bounds = [from ? Number(from) : null, to ? Number(to) : null];
                return extra.length || bounds.some((bound) => bound !== null && !Number.isFinite(bound))
                  ? range
                  : bounds;
              }),
            ];
          return [key, [...new Set(value.getAll(key))].sort()];
        }),
    );
  if (predicate(new URLSearchParams(context)) !== predicate(params)) params.delete('cursor');
  const query = params.toString();
  return `/${locale}/collections/${encodeURIComponent(id)}${query ? `?${query}` : ''}`;
}

export function filterTypeFromMembers(value: unknown): string | undefined {
  if (!isRecord(value) || typeof value.type !== 'string') return undefined;
  return value.type;
}
