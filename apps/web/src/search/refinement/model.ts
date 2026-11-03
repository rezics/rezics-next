import {
  admitFilter,
  facetProperties,
  type FilterDocument,
  type FilterRange,
  type FilterRelease,
} from '@rezics/filter';
import { searchFilterWithScope, type SearchResourceScope } from '../advanced-scope';

export type RefinementRelease = FilterRelease & {
  digest?: string;
  properties: Record<string, FilterRelease['properties'][string] & { labels?: Record<string, string> }>;
};
export type RefinementProperty = {
  property: string;
  labels: Record<string, string>;
  mode: 'values' | 'types' | 'range' | 'unsupported';
  datatype: string;
  units: readonly string[];
};
export type RefinementConditions = {
  kinds?: string[];
  languages?: string[];
  filter?: string;
  resourceScope?: SearchResourceScope;
  type?: string;
  facetValues: Record<string, string[]>;
  ranges?: Record<string, FilterRange>;
  condition?: FilterDocument;
};

/** Released own/base order, with no preview allowlist or per-vertical form. */
export function refinementProperties(
  release: RefinementRelease,
  type?: string | readonly string[],
): RefinementProperty[] {
  return [
    { property: 'type', labels: {}, mode: 'types' as const, datatype: 'type', units: [] },
    ...facetProperties(
      release,
      typeof type === 'string' ? [type] : type?.length ? type : Object.keys(release.types),
    ).map((property): RefinementProperty => {
      const definition = release.properties[property];
      const datatype = definition?.datatype ?? '';
      return {
        property,
        labels: definition?.labels ?? {},
        datatype,
        units: definition?.units ?? [],
        mode:
          datatype === 'quantity' || datatype === 'time'
            ? 'range'
            : datatype === 'wikibase-item' || (datatype === 'string' && definition?.value?.pattern)
              ? 'values'
              : 'unsupported',
      };
    }),
  ];
}

/** Preserve the closed Boolean tree, including NOT and same-statement qualifiers, in one admission. */
export function compileRefinement(
  release: FilterRelease,
  conditions: RefinementConditions,
): FilterDocument | undefined {
  const clauses: FilterDocument[] = [];
  if (conditions.condition) clauses.push(conditions.condition);
  if (conditions.type) clauses.push({ type: { in: [conditions.type] } });
  for (const [property, values] of Object.entries(conditions.facetValues))
    if (values.length)
      clauses.push(
        property === 'type'
          ? { type: { in: [...new Set(values)] } }
          : { statement: { property, in: [...new Set(values)] } },
      );
  for (const [property, range] of Object.entries(conditions.ranges ?? {}))
    clauses.push({ statement: { property, range } });
  if (!clauses.length) return;
  return admitFilter(clauses.length === 1 ? clauses[0]! : { and: clauses }, release, { saved: false });
}

/** Opaque cursors never survive a predicate edit; the untouched condition tree does. */
export function refinementHref(
  locale: string,
  query: string,
  conditions: RefinementConditions,
  sort?: 'rating',
  cursor?: string,
) {
  const params = new URLSearchParams();
  if (query) params.set('q', query);
  if (conditions.type) params.set('type', conditions.type);
  if (sort) params.set('sort', sort);
  for (const kind of conditions.kinds ?? []) params.append('kinds', kind);
  for (const language of conditions.languages ?? []) params.append('language', language);
  const filter = searchFilterWithScope(conditions.filter, conditions.resourceScope);
  if (filter) params.set('filter', filter);
  if (conditions.condition) params.set('condition', JSON.stringify(conditions.condition));
  for (const [property, values] of Object.entries(conditions.facetValues))
    for (const value of values) params.append(`f.${property}`, value);
  for (const [property, range] of Object.entries(conditions.ranges ?? {}))
    params.set(`r.${property}`, JSON.stringify(range));
  if (cursor) params.set('cursor', cursor);
  return `/${locale}/search${params.size ? `?${params}` : ''}`;
}
