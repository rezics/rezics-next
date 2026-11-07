import { parseFilter, type FilterDocument, type FilterRelease } from '@rezics/filter';

export type ConditionMetadata = Omit<FilterRelease, 'filters' | 'properties'> & {
  digest?: string;
  types: Record<string, FilterRelease['types'][string] & { labels?: Record<string, string> }>;
  properties: Record<
    string,
    FilterRelease['properties'][string] & { labels?: Record<string, string>; targets?: readonly string[] }
  >;
  filters?: Record<string, { filter: FilterDocument; labels?: Record<string, string> }>;
};
/** Only released public grammar metadata crosses the BFF; no Library profiles or owner fields. */
export function conditionMetadata(
  release: Omit<FilterRelease, 'filters'> &
    Pick<ConditionMetadata, 'types' | 'properties'> & {
      digest?: string;
      filters?: Record<string, { filter: unknown; labels?: Record<string, string> }>;
    },
): ConditionMetadata {
  const filters: NonNullable<ConditionMetadata['filters']> = {};
  for (const [id, definition] of Object.entries(release.filters ?? {})) {
    try {
      filters[id] = { filter: parseFilter(definition.filter), labels: { ...definition.labels } };
    } catch {
      // A malformed released reference stays unsupported; it never becomes an empty filter.
    }
  }
  return {
    types: Object.fromEntries(
      Object.entries(release.types).map(([id, definition]) => [
        id,
        {
          labels: definition.labels ?? {},
          bases: definition.bases ?? [],
          facets: definition.facets ?? [],
        },
      ]),
    ),
    properties: Object.fromEntries(
      Object.entries(release.properties).map(([id, definition]) => [
        id,
        {
          labels: definition.labels ?? {},
          datatype: definition.datatype,
          ...(definition.targets ? { targets: definition.targets } : {}),
          ...(definition.relation ? { relation: { group: definition.relation.group } } : {}),
          ...(definition.qualifiers ? { qualifiers: definition.qualifiers } : {}),
          ...(definition.units ? { units: definition.units } : {}),
          ...(definition.value ? { value: definition.value } : {}),
        },
      ]),
    ),
    ...(release.digest ? { digest: release.digest } : {}),
    ...(release.filters ? { filters } : {}),
  };
}
