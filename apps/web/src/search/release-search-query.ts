import { queryOptions } from '@tanstack/react-query';
import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import { admittedReleaseSearchTypes } from '@rezics/filter';
import * as v from 'valibot';
import { kernelClient } from '../kernel/client';
import { refreshRelease } from '../subject/definitions';
import { localizedLabel } from './results';
import { readDiscovery, type DiscoveryState } from './discovery';
import { parseReleaseSearch, releaseSearchRequest, type ParsedReleaseSearch } from './release-search';
import type { ReleaseSearchType } from './release-search-page';

export type ReleaseSearchResult = { parsed?: ParsedReleaseSearch; types?: ReleaseSearchType[]; state: DiscoveryState };

const readReleaseSearch = createServerFn({ method: 'GET' })
  .validator(v.object({ locale: v.string(), rawJson: v.pipe(v.string(), v.maxLength(65536)) }))
  .handler(async ({ data }): Promise<ReleaseSearchResult> => {
    const release = await refreshRelease();
    const raw = v.parse(v.record(v.string(), v.unknown()), JSON.parse(data.rawJson));
    const parsed = parseReleaseSearch(raw, release, data.locale);
    const types = admittedReleaseSearchTypes(release).map((id) => ({
      id,
      label: localizedLabel(release.types[id]?.labels ?? {}, data.locale).text || id,
    }));
    if (parsed.invalid.length) return { parsed, types, state: { status: 'invalid' } };
    const request = releaseSearchRequest(parsed.search, release);
    const result = await readDiscovery(request, async (body) =>
      kernelClient(data.locale).subjects.$search.post(body, { fetch: { signal: getRequest().signal } }),
    );
    return { parsed, types, state: result.discovery };
  });

export function releaseSearchQueryOptions(locale: string, raw: Record<string, unknown>, principal: string) {
  return queryOptions({
    queryKey: ['release-search', locale, principal, raw],
    queryFn: async ({ signal }): Promise<ReleaseSearchResult> => {
      try {
        return await readReleaseSearch({ data: { locale, rawJson: JSON.stringify(raw) }, signal });
      } catch (error) {
        if (signal.aborted || (error instanceof Error && error.name === 'AbortError')) throw error;
        return { state: { status: 'unavailable' } };
      }
    },
    staleTime: 0,
    gcTime: 0,
    retry: false,
    refetchOnMount: true,
    refetchOnWindowFocus: true,
    refetchOnReconnect: false,
  });
}
