import { admitFilter, facetProperties, type FilterDocument, type FilterRelease } from '@rezics/filter';

export type CollectionFilterParams = {
  selected: Record<string, string[]>;
  selectedLabels: Record<string, string>;
  ranges: Record<string, { from?: number; to?: number }>;
  ignored: string[];
  document?: FilterDocument;
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
  const facets = facetProperties(release, [type]).slice(0, 8);
  const labels = new Map(
    [...params].filter(([key]) => key.startsWith('l.')).map(([key, value]) => [key.slice(2), value]),
  );
  const clauses: FilterDocument[] = [];
  for (const [key, values] of groupParams(params)) {
    if (key === 'type') continue;
    if (key.startsWith('l.')) continue;
    const match = /^(f|r)\.(.+)$/.exec(key);
    if (!match || !facets.includes(match[2]!)) {
      ignored.push(key);
      continue;
    }
    const property = match[2]!;
    const definition = release.properties[property];
    if (!definition) {
      ignored.push(key);
      continue;
    }
    if (match[1] === 'f' && definition.datatype === 'wikibase-item') {
      const accepted: string[] = [];
      for (const value of values.slice(0, 64)) {
        try {
          admitFilter({ statement: { property, in: [value] } }, release);
          if (!accepted.includes(value)) accepted.push(value);
        } catch {
          ignored.push(key);
        }
      }
      if (accepted.length) {
        selected[property] = accepted;
        const label = labels.get(property);
        if (label && label.length <= 160) selectedLabels[property] = label;
        clauses.push({ statement: { property, in: accepted } });
      }
      continue;
    }
    if (match[1] === 'r' && definition.datatype === 'quantity') {
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
        ignored.push(key);
        continue;
      }
      const unit = definition.units?.[0];
      if (!unit) {
        ignored.push(key);
        continue;
      }
      const range = { ...(from === undefined ? {} : { gte: from }), ...(to === undefined ? {} : { lte: to }), unit };
      try {
        const clause = { statement: { property, range } } as FilterDocument;
        admitFilter(clause, release);
        ranges[property] = { ...(from === undefined ? {} : { from }), ...(to === undefined ? {} : { to }) };
        clauses.push(clause);
      } catch {
        ignored.push(key);
      }
      continue;
    }
    ignored.push(key);
  }
  if (clauses.length === 0) return { selected, selectedLabels, ranges, ignored };
  try {
    const document = admitFilter(clauses.length === 1 ? clauses[0]! : { and: clauses }, release);
    return { selected, selectedLabels, ranges, ignored, document };
  } catch {
    return { selected: {}, selectedLabels: {}, ranges: {}, ignored: [...ignored, ...clauses.map(() => 'filter')] };
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
): string {
  const params = new URLSearchParams();
  if (type) params.set('type', type);
  for (const [property, values] of Object.entries(selected))
    for (const value of values) params.append(`f.${property}`, value);
  for (const [property, label] of Object.entries(selectedLabels))
    if (selected[property]?.length && label) params.set(`l.${property}`, label);
  for (const [property, range] of Object.entries(ranges))
    params.set(`r.${property}`, `${range.from ?? ''},${range.to ?? ''}`);
  const query = params.toString();
  return `/${locale}/collections/${encodeURIComponent(id)}${query ? `?${query}` : ''}`;
}

export function filterTypeFromMembers(value: unknown): string | undefined {
  if (!isRecord(value) || typeof value.type !== 'string') return undefined;
  return value.type;
}
