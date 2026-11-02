import type { FilterRelease } from '@rezics/filter';
import { readCollectionFilterParams } from './collection-filter-params';

/** Preserve every admitted address field; display hints cannot displace predicate fields. */
export function collectionFilterSearch(input: object): Record<string, string | string[]> {
  const search: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(input)) {
    if (key === 'type' && typeof value === 'string' && value.length <= 128) search[key] = value;
    else if (
      /^[frl]\.[a-zA-Z0-9:_.-]{1,128}$/.test(key) &&
      (typeof value === 'string' || (Array.isArray(value) && value.every((entry) => typeof entry === 'string')))
    )
      search[key] = value as string | string[];
  }
  return search;
}

/** A rejected address never supplies either a partial filter or an unfiltered members read. */
export function readCollectionFilterAddress(
  search: Record<string, string | string[]>,
  release: FilterRelease,
  type: string,
) {
  const filterParams = readCollectionFilterParams(
    new URLSearchParams(
      Object.entries(search).flatMap(([key, value]) =>
        (Array.isArray(value) ? value : [value]).map((entry) => [key, entry] as [string, string]),
      ),
    ),
    release,
    type,
  );
  return {
    filterParams,
    ...(filterParams.document ? { filter: filterParams.document } : {}),
    ...(filterParams.issues?.length ? { filterStatus: 'failed' as const } : {}),
  };
}
