import { queryOptions } from '@tanstack/react-query';
import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import { admittedReleaseSearchTypes } from '@rezics/filter';
import * as v from 'valibot';
import { kernelClient } from '../kernel/client';
import { refreshRelease } from '../subject/definitions';
import { localizedLabel } from './results';
import { discoveryFailure, parseLegacySearchPage, type DiscoveryState } from './discovery';
import {
  parseReleaseSearch,
  releaseSearchRequest,
  type ReleaseGroupedRequest,
  type ParsedReleaseSearch,
  type ReleaseSearchSelections,
} from './release-search';
import type { ReleaseSearchType } from './release-search-page';
import type { ResultHit } from './results';

export type ReleaseSearchGroup =
  | { kind: 'work'; id: string; work: ResultHit; releases: ResultHit[]; next: string | null }
  | { kind: 'release'; id: string; release: ResultHit; workLink: string };
export type ReleaseGroupedPage = {
  status: 'ready' | 'preparing';
  groups: ReleaseSearchGroup[];
  next: string | null;
  as_of: string;
};
export type ReleaseChildrenState =
  | { status: 'ready' | 'preparing'; children: ResultHit[]; next: string | null }
  | Exclude<DiscoveryState, { status: 'ready' }>;
export type ReleaseGroupedState =
  | { status: 'ready' | 'preparing'; page: ReleaseGroupedPage }
  | Exclude<DiscoveryState, { status: 'ready' }>;

export type ReleaseSearchResult = {
  parsed?: ParsedReleaseSearch;
  types?: ReleaseSearchType[];
  selections?: ReleaseSearchSelections;
  request?: ReleaseGroupedRequest;
  state: ReleaseGroupedState;
};

const subjectId = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function resultHit(value: unknown, asOf: string): ResultHit | undefined {
  const page = parseLegacySearchPage({ subjects: [value], next: null, as_of: asOf });
  const hit = page?.subjects[0];
  if (!hit) return;
  const { summary, ...rest } = hit;
  return { ...rest, ...(summary === null ? {} : { summary }) } as ResultHit;
}

function cursor(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && value.length > 0 && value.length <= 4864);
}

function parseGroupedPage(value: unknown): ReleaseGroupedPage | undefined {
  if (
    !record(value) ||
    value.operation !== 'groups' ||
    !['ready', 'preparing'].includes(String(value.status)) ||
    !Array.isArray(value.groups) ||
    value.groups.length > 20 ||
    !cursor(value.next) ||
    typeof value.as_of !== 'string'
  )
    return;
  const groups: ReleaseSearchGroup[] = [];
  for (const item of value.groups) {
    if (!record(item) || typeof item.id !== 'string') return;
    if (item.kind === 'work') {
      if (!Array.isArray(item.releases) || item.releases.length > 20 || !cursor(item.next)) return;
      const work = resultHit(item.work, value.as_of);
      const releases = item.releases.map((hit) => resultHit(hit, value.as_of));
      if (!work || work.id !== item.id || releases.some((hit) => !hit)) return;
      groups.push({ kind: 'work', id: item.id, work, releases: releases as ResultHit[], next: item.next });
    } else if (
      item.kind === 'release' &&
      ['missing', 'unknown', 'conflicting', 'unavailable', 'unproven'].includes(String(item.workLink))
    ) {
      const release = resultHit(item.release, value.as_of);
      if (!release || release.id !== item.id) return;
      groups.push({ kind: 'release', id: item.id, release, workLink: String(item.workLink) });
    } else return;
  }
  return {
    status: value.status as 'ready' | 'preparing',
    groups,
    next: value.next,
    as_of: value.as_of,
  };
}

function parseChildrenPage(value: unknown): Extract<ReleaseChildrenState, { children: ResultHit[] }> | undefined {
  if (
    !record(value) ||
    value.operation !== 'children' ||
    !['ready', 'preparing'].includes(String(value.status)) ||
    !Array.isArray(value.children) ||
    value.children.length > 20 ||
    !cursor(value.next) ||
    typeof value.as_of !== 'string'
  )
    return;
  const children = value.children.map((hit) => resultHit(hit, value.as_of));
  if (children.some((hit) => !hit)) return;
  return {
    status: value.status as 'ready' | 'preparing',
    children: children as ResultHit[],
    next: value.next,
  };
}

async function requestGroupedRelease(
  locale: string,
  body: ReleaseGroupedRequest & { operation?: 'groups' | 'children'; work?: string },
  signal: AbortSignal,
): Promise<ReleaseGroupedState | ReleaseChildrenState> {
  try {
    const response = await kernelClient(locale).subjects.$search.post(body, { fetch: { signal } });
    if (response.error || response.status !== 200)
      return discoveryFailure(response.status, response.error ?? response.data);
    if (body.operation === 'children') {
      const page = parseChildrenPage(response.data);
      return page ?? { status: 'unavailable' };
    }
    const page = parseGroupedPage(response.data);
    return page ? { status: page.status, page } : { status: 'unavailable' };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    return { status: 'unavailable' };
  }
}

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
    const state = await requestGroupedRelease(data.locale, request, getRequest().signal);
    if ('children' in state) return { parsed, types, selections, request, state: { status: 'unavailable' } };
    return { parsed, types, selections, request, state };
  });

const readReleaseChildren = createServerFn({ method: 'GET' })
  .validator(
    v.object({
      locale: v.string(),
      bodyJson: v.pipe(v.string(), v.maxLength(65536)),
    }),
  )
  .handler(async ({ data }): Promise<ReleaseChildrenState> => {
    const body = v.parse(v.record(v.string(), v.unknown()), JSON.parse(data.bodyJson)) as ReleaseGroupedRequest & {
      operation: 'children';
      work: string;
    };
    const state = await requestGroupedRelease(data.locale, body, getRequest().signal);
    return 'children' in state || state.status !== 'ready' && state.status !== 'preparing'
      ? state as ReleaseChildrenState
      : { status: 'unavailable' };
  });

export async function loadReleaseChildren(
  locale: string,
  request: ReleaseGroupedRequest,
  work: string,
  cursor: string,
): Promise<ReleaseChildrenState> {
  return readReleaseChildren({
    data: {
      locale,
      bodyJson: JSON.stringify({ ...request, operation: 'children', work, cursor }),
    },
  });
}

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
