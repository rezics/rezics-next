import { queryOptions } from '@tanstack/react-query';
import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { admittedReleaseSearchTypes } from '@rezics/filter';
import * as v from 'valibot';
import { kernelClient } from '../kernel/client';
import { refreshRelease } from '../subject/definitions';
import { localizedLabel } from './results';
import { discoveryFailure, parseLegacySearchPage, type DiscoveryState } from './discovery';
import {
  parseReleaseSearch,
  releaseSearchRequest,
  type ParsedReleaseSearch,
  type ReleaseSearchRequest,
  type ReleaseSearchSelections,
} from './release-search';
import type { ReleaseSearchType } from './release-search-page';
import { browserObservation } from '../session';
import { assertReaderCurrent } from '../session/reader';

export type ReleaseSearchResult = {
  parsed?: ParsedReleaseSearch;
  types?: ReleaseSearchType[];
  selections?: ReleaseSearchSelections;
  state: ReleaseSearchState;
};

type FailureState = { status: Exclude<DiscoveryState['status'], 'ready' | 'preparing'> };
type SerializableJson = null | boolean | number | string | SerializableJson[] | { [key: string]: SerializableJson };
type ReleaseSearchBase = { [key: string]: SerializableJson };
export type ReleaseSearchCard = NonNullable<ReturnType<typeof parseLegacySearchPage>>['subjects'][number] & {
  kind: string;
  base: ReleaseSearchBase;
};
export type ReleaseSearchGroup =
  | { kind: 'work'; id: string; work: ReleaseSearchCard; releases: ReleaseSearchCard[]; next: string | null }
  | {
      kind: 'release';
      id: string;
      release: ReleaseSearchCard;
      workLink: ReleaseWorkLinkState;
    };
type ReleaseWorkLinkState = 'missing' | 'unknown' | 'conflicting' | 'unavailable' | 'unproven';
export type ReleaseSearchGroupsPage = {
  status: 'ready' | 'preparing';
  groups: ReleaseSearchGroup[];
  next: string | null;
  as_of: string;
};
export type ReleaseSearchChildrenPage = {
  status: 'ready' | 'preparing';
  children: ReleaseSearchCard[];
  next: string | null;
  as_of: string;
};
export type ReleaseSearchState =
  | FailureState
  | { status: 'ready'; page: ReleaseSearchGroupsPage }
  | { status: 'preparing'; page: ReleaseSearchGroupsPage };
export type ReleaseSearchChildrenState =
  | FailureState
  | { status: 'ready'; page: ReleaseSearchChildrenPage }
  | { status: 'preparing'; page: ReleaseSearchChildrenPage };

const cursorLimit = 4864;

type GroupedSearchResponse = { status: number; data?: unknown; error?: unknown };

async function postGrouped(
  request: ReleaseSearchRequest,
  locale: string,
  signal: AbortSignal | undefined,
): Promise<GroupedSearchResponse> {
  // The shared generated client still describes discovery-v1; this route's new representation is parsed below.
  const post = kernelClient(locale).subjects.$search.post as unknown as (
    body: ReleaseSearchRequest,
    options?: { fetch?: RequestInit },
  ) => Promise<GroupedSearchResponse>;
  return post(request, signal ? { fetch: { signal } } : {});
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function cursor(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && value.length > 0 && value.length <= cursorLimit);
}

function timestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function releaseCard(value: unknown): ReleaseSearchCard | undefined {
  if (!record(value) || typeof value.id !== 'string' || typeof value.type !== 'string' || value.kind !== value.type)
    return;
  if (!record(value.base) || value.base.id !== value.id || value.base.kind !== value.type || !record(value.base.url))
    return;
  if (value.base.url.id !== value.id || !Object.hasOwn(value, 'figure')) return;
  const page = parseLegacySearchPage({ subjects: [value], next: null, as_of: '2000-01-01T00:00:00.000Z' });
  const subject = page?.subjects[0];
  if (!subject) return;
  return { ...subject, kind: value.kind, base: value.base as ReleaseSearchBase };
}

export function parseReleaseSearchGroupsPage(value: unknown): ReleaseSearchGroupsPage | undefined {
  if (
    !record(value) ||
    (value.status !== 'ready' && value.status !== 'preparing') ||
    !Array.isArray(value.groups) ||
    value.groups.length > 20 ||
    !cursor(value.next) ||
    !timestamp(value.as_of) ||
    (value.status === 'preparing' && (value.groups.length > 0 || value.next === null))
  )
    return;
  const identities = new Set<string>();
  const groups: ReleaseSearchGroup[] = [];
  for (const raw of value.groups) {
    if (!record(raw) || typeof raw.id !== 'string') return;
    if (raw.kind === 'work') {
      const work = releaseCard(raw.work);
      if (
        !work ||
        work.id !== raw.id ||
        !Array.isArray(raw.releases) ||
        raw.releases.length < 1 ||
        raw.releases.length > 3 ||
        !cursor(raw.next)
      )
        return;
      const releases = raw.releases.map(releaseCard);
      if (releases.some((release) => !release)) return;
      const cards = [work, ...(releases as ReleaseSearchCard[])];
      for (const card of cards) {
        if (identities.has(card.id)) return;
        identities.add(card.id);
      }
      groups.push({ kind: 'work', id: raw.id, work, releases: releases as ReleaseSearchCard[], next: raw.next });
    } else if (raw.kind === 'release') {
      const release = releaseCard(raw.release);
      if (
        !release ||
        release.id !== raw.id ||
        !['missing', 'unknown', 'conflicting', 'unavailable', 'unproven'].includes(String(raw.workLink)) ||
        identities.has(release.id)
      )
        return;
      identities.add(release.id);
      groups.push({
        kind: 'release',
        id: raw.id,
        release,
        workLink: raw.workLink as ReleaseWorkLinkState,
      });
    } else return;
  }
  if (new Set(groups.map(({ id }) => id)).size !== groups.length) return;
  return { status: value.status, groups, next: value.next, as_of: value.as_of };
}

export function parseReleaseSearchChildrenPage(value: unknown): ReleaseSearchChildrenPage | undefined {
  if (
    !record(value) ||
    (value.status !== 'ready' && value.status !== 'preparing') ||
    !Array.isArray(value.children) ||
    value.children.length > 20 ||
    !cursor(value.next) ||
    !timestamp(value.as_of) ||
    (value.status === 'preparing' && (value.children.length > 0 || value.next === null))
  )
    return;
  const children = value.children.map(releaseCard);
  if (children.some((child) => !child) || new Set(children.map((child) => child!.id)).size !== children.length) return;
  return { status: value.status, children: children as ReleaseSearchCard[], next: value.next, as_of: value.as_of };
}

async function sendGrouped(
  request: ReleaseSearchRequest,
  locale: string,
  signal: AbortSignal | undefined,
): Promise<ReleaseSearchState> {
  const response = await postGrouped(request, locale, signal);
  if (response.error || response.status !== 200) return failureState(response.status, response.error ?? response.data);
  const page = parseReleaseSearchGroupsPage(response.data);
  return page ? { status: page.status, page } : { status: 'unavailable' };
}

async function sendChildren(
  request: ReleaseSearchRequest,
  locale: string,
  signal: AbortSignal | undefined,
): Promise<ReleaseSearchChildrenState> {
  const response = await postGrouped(request, locale, signal);
  if (response.error || response.status !== 200) return failureState(response.status, response.error ?? response.data);
  const page = parseReleaseSearchChildrenPage(response.data);
  return page ? { status: page.status, page } : { status: 'unavailable' };
}

function failureState(status: number, error: unknown): FailureState {
  const failure = discoveryFailure(status, error);
  if (failure.status === 'preparing') return { status: 'not-ready' };
  return { status: failure.status as FailureState['status'] };
}

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
    setResponseHeader('Cache-Control', 'private, no-store');
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
    const state = await sendGrouped(request, data.locale, getRequest().signal);
    return { parsed, types, selections, state };
  });

export const readReleaseSearchChildren = createServerFn({ method: 'POST' })
  .validator(
    v.object({
      locale: v.string(),
      rawJson: v.pipe(v.string(), v.maxLength(65536)),
      work: v.pipe(v.string(), v.regex(subjectId)),
      cursor: v.pipe(v.string(), v.minLength(1), v.maxLength(cursorLimit)),
    }),
  )
  .handler(async ({ data }): Promise<ReleaseSearchChildrenState> => {
    const release = await refreshRelease();
    const raw = v.parse(v.record(v.string(), v.unknown()), JSON.parse(data.rawJson));
    const parsed = parseReleaseSearch(raw, release, data.locale);
    if (parsed.invalid.length) return { status: 'invalid' };
    const request = releaseSearchRequest(parsed.search, release);
    delete request.cursor;
    request.work = data.work;
    request.childCursor = data.cursor;
    return sendChildren(request, data.locale, getRequest().signal);
  });

export function releaseSearchQueryOptions(locale: string, raw: Record<string, unknown>, principal: string) {
  return queryOptions({
    queryKey: ['release-search', locale, principal, raw],
    queryFn: async ({ signal, client }): Promise<ReleaseSearchResult> => {
      const store = browserObservation(client);
      const stop = typeof window === 'undefined' ? undefined : store.subscribe(() => {});
      const observation = store.getSnapshot();
      const current = () => store.getSnapshot() === observation;
      try {
        assertReaderCurrent(current, signal);
        const result = await readReleaseSearch({ data: { locale, rawJson: JSON.stringify(raw) }, signal });
        assertReaderCurrent(current, signal);
        return result;
      } catch (error) {
        assertReaderCurrent(current, signal);
        if (signal.aborted || (error instanceof Error && error.name === 'AbortError')) throw error;
        return { state: { status: 'unavailable' } };
      } finally {
        stop?.();
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
