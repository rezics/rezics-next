import { queryOptions } from '@tanstack/react-query';
import { createServerFn } from '@tanstack/react-start';
import { notFound } from '@tanstack/react-router';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { nameSubjectTypes } from '../subject/definitions';
import { kernelClient } from '../kernel/client';
import { personalRead, publicRead, readQueryKey } from '../kernel/query';
import type { ReadCredentialMode } from '../kernel/credential';
import type { SessionEnv } from '../session/client';
import { loadEditableCollectionPage, loadDynamicMembers, type CollectionPageResult } from './collection-load';
import { prepareSession, viewerCredential } from '../session/request';
import { readRelease } from '../subject/definitions';
import { readCollectionFilterParams } from './collection-filter-params';
import { facetProperties } from '@rezics/filter';
import { requestLocale } from '../kernel/client';
import { m } from '../paraglide/messages.js';

function validatePageInput(input: unknown): {
  id: string;
  cursor?: string;
  credentialMode: ReadCredentialMode;
  search?: Record<string, string | string[]>;
} {
  if (
    !input ||
    typeof input !== 'object' ||
    !('id' in input) ||
    typeof input.id !== 'string' ||
    !input.id ||
    input.id.length > 128 ||
    ('cursor' in input && input.cursor !== undefined && typeof input.cursor !== 'string') ||
    ('credentialMode' in input &&
      input.credentialMode !== undefined &&
      input.credentialMode !== 'anonymous' &&
      input.credentialMode !== 'session')
  )
    throw notFound();
  const search: Record<string, string | string[]> = {};
  if ('search' in input && input.search && typeof input.search === 'object') {
    for (const [key, value] of Object.entries(input.search).slice(0, 16)) {
      if (key === 'type' && typeof value === 'string' && value.length <= 128) search[key] = value;
      else if (
        /^[frl]\.[a-zA-Z0-9:_.-]{1,128}$/.test(key) &&
        (typeof value === 'string' || (Array.isArray(value) && value.every((entry) => typeof entry === 'string')))
      )
        search[key] = value as string | string[];
    }
  }
  return {
    id: input.id,
    ...('cursor' in input && typeof input.cursor === 'string' && input.cursor ? { cursor: input.cursor } : {}),
    credentialMode: 'credentialMode' in input && input.credentialMode === 'session' ? 'session' : 'anonymous',
    ...(Object.keys(search).length ? { search } : {}),
  };
}

function hasActiveFilter(search: Record<string, string | string[]> | undefined): boolean {
  return Object.entries(search ?? {}).some(([key, value]) => {
    if (!/^(f|r)\./.test(key)) return false;
    return Array.isArray(value) ? value.some(Boolean) : Boolean(value);
  });
}

export const readCollectionPage = createServerFn({ method: 'GET' })
  .validator(validatePageInput)
  .handler(async ({ data }): Promise<CollectionPageResult> => {
    setResponseHeader('cache-control', 'private, no-store');
    const configuredFilters = (env as { COLLECTION_FILTERS?: boolean | string }).COLLECTION_FILTERS;
    const filtersOn =
      configuredFilters === undefined
        ? import.meta.env.DEV
        : configuredFilters === true || configuredFilters === 'true';
    let filter: ReturnType<typeof readCollectionFilterParams> | undefined;
    let filterStatus: 'failed' | undefined = !filtersOn && hasActiveFilter(data.search) ? 'failed' : undefined;
    let filterProperties: {
      id: string;
      label: string;
      datatype: string;
      unit?: string;
      targets?: readonly string[];
    }[] = [];
    const requested = data.search ?? {};
    const type = typeof requested.type === 'string' ? requested.type : 'schema:Book';
    if (filtersOn) {
      try {
        const release = await readRelease();
        const locale = requestLocale() ?? 'en';
        filterProperties = facetProperties(release, [type])
          .slice(0, 8)
          .flatMap((id) => {
            const definition = release.properties[id];
            if (!definition || !['wikibase-item', 'quantity'].includes(definition.datatype)) return [];
            const labels = (definition as typeof definition & { labels?: Record<string, string> }).labels ?? {};
            return [
              {
                id,
                datatype: definition.datatype,
                label: labels[locale] ?? labels[locale.split('-')[0]!] ?? labels.en ?? m.collection_filters(),
                ...(definition.units?.[0] ? { unit: definition.units[0] } : {}),
                ...(definition.targets ? { targets: definition.targets } : {}),
              },
            ];
          });
        filter = readCollectionFilterParams(
          new URLSearchParams(
            Object.entries(requested).flatMap(([key, value]) =>
              (Array.isArray(value) ? value : [value]).map((entry) => [key, entry] as [string, string]),
            ),
          ),
          release,
          type,
        );
      } catch {
        if (hasActiveFilter(requested)) filterStatus = 'failed';
      }
    }
    const page = await loadEditableCollectionPage(
      kernelClient(),
      getRequest(),
      env as Partial<SessionEnv>,
      {
        ...data,
        ...(filter?.document ? { filter: filter.document } : {}),
        ...(filterStatus ? { filterStatus } : {}),
        ...(filter ? { filterIgnored: filter.ignored, filterType: type, filterProperties, filterParams: filter } : {}),
      },
      data.credentialMode,
    );
    await nameSubjectTypes(page.members.map((member) => member.subject));
    return {
      ...page,
      ...(filtersOn
        ? { filterProperties, filterParams: filter ?? { selected: {}, selectedLabels: {}, ranges: {}, ignored: [] } }
        : {}),
    };
  });

export const readDynamicCollectionMembers = createServerFn({ method: 'GET' })
  .validator((input: unknown) => {
    if (
      !input ||
      typeof input !== 'object' ||
      !('id' in input) ||
      typeof input.id !== 'string' ||
      !input.id ||
      ('cursor' in input && input.cursor !== undefined && typeof input.cursor !== 'string')
    )
      throw notFound();
    const search: Record<string, string | string[]> = {};
    if ('search' in input && input.search && typeof input.search === 'object') {
      for (const [key, value] of Object.entries(input.search).slice(0, 16))
        if (key === 'type' && typeof value === 'string' && value.length <= 128) search[key] = value;
        else if (
          /^[frl]\.[a-zA-Z0-9:_.-]{1,128}$/.test(key) &&
          (typeof value === 'string' || (Array.isArray(value) && value.every((entry) => typeof entry === 'string')))
        )
          search[key] = value as string | string[];
    }
    return {
      id: input.id,
      ...('cursor' in input && typeof input.cursor === 'string' && input.cursor ? { cursor: input.cursor } : {}),
      ...(Object.keys(search).length ? { search } : {}),
    };
  })
  .handler(async ({ data }) => {
    setResponseHeader('cache-control', 'private, no-store');
    const request = getRequest();
    const signedOut = await prepareSession(request, env as Partial<SessionEnv>).then(
      (stale) => stale,
      () => true,
    );
    const authorization = signedOut ? null : viewerCredential(request);
    let filter;
    const configuredFilters = (env as { COLLECTION_FILTERS?: boolean | string }).COLLECTION_FILTERS;
    const filtersOn =
      configuredFilters === undefined
        ? import.meta.env.DEV
        : configuredFilters === true || configuredFilters === 'true';
    if (!filtersOn && hasActiveFilter(data.search))
      return {
        members: [],
        next: null,
        preparing: false,
        retryAfterMs: 1000,
        unavailable: false,
        filterStatus: 'failed',
      };
    if (filtersOn && data.search) {
      try {
        const type = typeof data.search.type === 'string' ? data.search.type : 'schema:Book';
        filter = readCollectionFilterParams(
          new URLSearchParams(
            Object.entries(data.search).flatMap(([key, value]) =>
              (Array.isArray(value) ? value : [value]).map((entry) => [key, entry] as [string, string]),
            ),
          ),
          await readRelease(),
          type,
        ).document;
      } catch {
        if (hasActiveFilter(data.search))
          return {
            members: [],
            next: null,
            preparing: false,
            retryAfterMs: 1000,
            unavailable: false,
            filterStatus: 'failed',
          };
      }
    }
    return loadDynamicMembers(
      kernelClient(),
      data.id,
      data.cursor,
      authorization ? { headers: { authorization } } : {},
      filter,
    );
  });

export function collectionPageQuery(
  id: string,
  cursor: string | undefined,
  credentialMode: ReadCredentialMode = 'anonymous',
  search?: Record<string, string | string[]>,
) {
  const preset = credentialMode === 'session' ? personalRead : publicRead;
  return queryOptions({
    ...preset,
    queryKey: readQueryKey(['collection-page', id, cursor ?? null, search ?? null], credentialMode),
    queryFn: () =>
      readCollectionPage({
        data: { id, ...(cursor === undefined ? {} : { cursor }), credentialMode, ...(search ? { search } : {}) },
      }),
  });
}

export function personalCollectionPageQuery(id: string, cursor?: string, search?: Record<string, string | string[]>) {
  return queryOptions({
    ...personalRead,
    queryKey: readQueryKey(['collection-page', id, cursor ?? null, search ?? null], 'session'),
    queryFn: async () => {
      const page = await readCollectionPage({
        data: {
          id,
          ...(cursor === undefined ? {} : { cursor }),
          credentialMode: 'session',
          ...(search ? { search } : {}),
        },
      });
      if ('preparing' in page) throw notFound();
      return page;
    },
  });
}
