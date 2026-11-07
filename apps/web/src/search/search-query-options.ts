import { queryOptions } from '@tanstack/react-query';
import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import { workspaceAdmission } from '../session/reader';
import { personalRead, publicRead } from '../kernel/query';
import { kernelClient } from '../kernel/client';
import { requestLanguages } from '../kernel/languages';
import { readRelease } from '../subject/definitions';
import { readScopedSearchReader } from './search-reader';
import { searchRequiresCurrentReader } from './scoped-search-lifetime';
import type { SearchLoaderDeps } from './search-params';
import { createSearchApplication, requestParams } from './search-application';
import type { SearchPageData, SearchRequestParams } from './search-query-contract';
import { validateSearchInput } from './search-query-input';

/** Search composition captures the existing locale-scoped client provider once for every request path. */
export const searchApplication = createSearchApplication({
  createClient: kernelClient,
  readRelease,
  requestLanguages,
});

const readSearchWithLocale = createServerFn({ method: 'GET' })
  .validator(validateSearchInput)
  .handler(async ({ data }): Promise<SearchPageData> => {
    const request = getRequest();
    const requiresReader = searchRequiresCurrentReader(data);
    const reader = requiresReader ? await readScopedSearchReader(request) : undefined;
    if (requiresReader && (!reader || data.reader !== reader.owner))
      return { ...searchApplication.unavailablePage(requestParams(data)), recovery: { status: 'session' } };
    return searchApplication.read(data, {
      signal: request.signal,
      ...(reader ? { reader } : {}),
    });
  });

function readSearch({
  data,
  locale,
  signal,
}: {
  data: Omit<SearchRequestParams, 'locale'>;
  locale: string;
  signal?: AbortSignal;
}): Promise<SearchPageData> {
  return readSearchWithLocale({ data: { ...data, locale }, ...(signal ? { signal } : {}) });
}

export function searchQueryOptions(locale: string, params: SearchLoaderDeps, reader?: string) {
  const scoped = searchRequiresCurrentReader(params);
  return queryOptions({
    ...(scoped ? personalRead : publicRead),
    staleTime: 0,
    gcTime: scoped ? 0 : 60_000,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
    queryKey: searchApplication.queryKey(locale, params, reader),
    queryFn: async ({ signal: querySignal, client }) => {
      const retired = new AbortController();
      const admission = typeof window === 'undefined' ? undefined : workspaceAdmission(client, []);
      const origin = admission?.read();
      const stop = admission?.subscribe(() => {
        if (admission.read() !== origin) retired.abort();
      });
      const signal = AbortSignal.any([querySignal, retired.signal]);
      try {
        const page = await readSearch({
          locale,
          signal,
          data: {
            query: params.query,
            kinds: params.kinds,
            languages: params.languages,
            filter: params.filter,
            ...(params.resourceScope ? { resourceScope: params.resourceScope } : {}),
            ...(params.ratingPopulation ? { ratingPopulation: params.ratingPopulation } : {}),
            ...(scoped && reader ? { reader } : {}),
            ...(params.ranges ? { ranges: params.ranges } : {}),
            ...(params.condition ? { condition: params.condition } : {}),
            ...(params.type ? { type: params.type } : {}),
            facetValues: params.facets,
            ...(params.cursor ? { cursor: params.cursor } : {}),
            ...(params.sort ? { sort: params.sort } : {}),
          },
        });
        signal.throwIfAborted();
        return page;
      } catch (error) {
        if (querySignal.aborted) throw error;
        if (retired.signal.aborted) return searchApplication.unavailablePage(params);
        if (error instanceof Error && error.name === 'AbortError') throw error;
        return searchApplication.unavailablePage(params);
      } finally {
        stop?.();
      }
    },
  });
}

