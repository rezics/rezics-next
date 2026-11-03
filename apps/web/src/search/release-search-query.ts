import { queryOptions } from '@tanstack/react-query';
import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import { admittedReleaseSearchTypes } from '@rezics/filter';
import * as v from 'valibot';
import { kernelClient } from '../kernel/client';
import { refreshRelease } from '../subject/definitions';
import { localizedLabel } from './results';
import { readDiscovery, type DiscoveryState } from './discovery';
import {
  parseReleaseSearch,
  releaseSearchRequest,
  type ParsedReleaseSearch,
  type ReleaseSearchSelections,
} from './release-search';
import type { ReleaseSearchType } from './release-search-page';

export type ReleaseSearchResult = {
  parsed?: ParsedReleaseSearch;
  types?: ReleaseSearchType[];
  selections?: ReleaseSearchSelections;
  state: DiscoveryState;
};

const subjectId = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function readSelections(parsed: ParsedReleaseSearch, locale: string): Promise<ReleaseSearchSelections> {
  const request = getRequest();
  const [{ readSubjectSuggestions }, { viewerCredential }] = await Promise.all([
    import('./suggestions'),
    import('../session/request'),
  ]);
  const credential = viewerCredential(request);
  const languages = [...new Set([locale, 'en'])];
  const client = kernelClient(locale);
  const names = ['platform', 'developer', 'publisher'] as const;
  const values = await Promise.all(
    names.map(async (name) => {
      const id = parsed.form[name];
      if (!id) return [name, undefined] as const;
      let label: string | undefined;
      let type: string | undefined;
      if (subjectId.test(id)) {
        try {
          const page = await readSubjectSuggestions(
            client,
            { q: id, limit: 10, languages },
            credential,
            request.signal,
          );
          const subject = page.subjects.find((entry) => entry.id.toLowerCase() === id.toLowerCase());
          if (subject) {
            label = localizedLabel(subject.labels, locale).text || undefined;
            type = subject.type;
          }
        } catch (error) {
          if (request.signal.aborted) throw error;
        }
      }
      return [name, { id, ...(label ? { label } : {}), ...(type ? { type } : {}) }] as const;
    }),
  );
  return Object.fromEntries(values.filter((entry) => entry[1] !== undefined)) as ReleaseSearchSelections;
}

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
    const selections = await readSelections(parsed, data.locale);
    if (parsed.invalid.length) return { parsed, types, selections, state: { status: 'invalid' } };
    const request = releaseSearchRequest(parsed.search, release);
    const result = await readDiscovery(request, async (body) =>
      kernelClient(data.locale).subjects.$search.post(body, { fetch: { signal: getRequest().signal } }),
    );
    return { parsed, types, selections, state: result.discovery };
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
