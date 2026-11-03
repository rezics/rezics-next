import { readCollectionTypeOptions } from './collection-presentation';
import { queryOptions } from '@tanstack/react-query';
import { createServerFn } from '@tanstack/react-start';
import { notFound } from '@tanstack/react-router';
import { getRequest, setResponseHeader, setResponseStatus } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { nameSubjectTypes } from '../subject/definitions';
import { kernelClient } from '../kernel/client';
import { personalRead, publicRead, readQueryKey } from '../kernel/query';
import type { ReadCredentialMode } from '../kernel/credential';
import type { SessionEnv } from '../session/client';
import {
  collectionRenderPolicy,
  collectionRequestVariant,
  collectionResultMatches,
  loadEditableCollectionPage,
  type CollectionPageResult,
  type DynamicMembersResult,
} from './collection-load';
import { readRelease } from '../subject/definitions';
import { readCollectionFilterParams } from './collection-filter-params';
import { collectionFilterSearch, readCollectionFilterAddress } from './collection-filter-address-read';
import { requestLocale } from '../kernel/client';
import { m } from '../paraglide/messages.js';
import { isPublicCacheRender, publicPageCacheControl, recordPublicPageCachePolicy } from '../security/page-cache';
import { refinementProperties } from '../search/refinement/model';
import type { CollectionFilterProperty } from './collection-filters';

function validatePageInput(input: unknown): {
  id: string;
  cursor?: string;
  credentialMode: ReadCredentialMode;
  editor?: boolean;
  filterActive: boolean;
  search?: Record<string, string | string[]>;
} {
  if (
    !input ||
    typeof input !== 'object' ||
    !('id' in input) ||
    typeof input.id !== 'string' ||
    !input.id ||
    input.id.length > 128 ||
    ('editor' in input &&
      input.editor !== undefined &&
      (typeof input.editor !== 'boolean' ||
        (input.editor && (!('credentialMode' in input) || input.credentialMode !== 'session')))) ||
    ('cursor' in input && input.cursor !== undefined && typeof input.cursor !== 'string') ||
    ('credentialMode' in input &&
      input.credentialMode !== undefined &&
      input.credentialMode !== 'anonymous' &&
      input.credentialMode !== 'session')
  )
    throw notFound();
  const search =
    'search' in input && input.search && typeof input.search === 'object' ? collectionFilterSearch(input.search) : {};
  return {
    id: input.id,
    filterActive:
      'search' in input && input.search !== null && typeof input.search === 'object' && hasActiveFilter(input.search),
    ...('editor' in input && input.editor === true ? { editor: true } : {}),
    ...('cursor' in input && typeof input.cursor === 'string' && input.cursor ? { cursor: input.cursor } : {}),
    credentialMode: 'credentialMode' in input && input.credentialMode === 'session' ? 'session' : 'anonymous',
    ...(Object.keys(search).length ? { search } : {}),
  };
}

function hasActiveFilter(search: object | undefined): boolean {
  return Object.entries(search ?? {}).some(([key, value]) => {
    if (/^[fr]\./.test(key)) return true;
    if (key !== 'type') return false;
    return Array.isArray(value)
      ? value.some((entry) => typeof entry === 'string' && Boolean(entry))
      : typeof value === 'string' && Boolean(value);
  });
}

export const readCollectionPage = createServerFn({ method: 'GET' })
  .validator(validatePageInput)
  .handler(async ({ data }): Promise<CollectionPageResult> => {
    setResponseHeader('cache-control', 'private, no-store');
    const request = getRequest();
    recordPublicPageCachePolicy(request, 'private');
    const configuredFilters = (env as { COLLECTION_FILTERS?: boolean | string }).COLLECTION_FILTERS;
    const filtersOn =
      configuredFilters === undefined
        ? import.meta.env.DEV
        : configuredFilters === true || configuredFilters === 'true';
    let filter: ReturnType<typeof readCollectionFilterParams> | undefined;
    let filterStatus: 'failed' | undefined = !filtersOn && data.filterActive ? 'failed' : undefined;
    let filterProperties: CollectionFilterProperty[] = [];
    let filterReleaseKey: string | undefined;
    const requested = data.search ?? {};
    const type = typeof requested.type === 'string' ? requested.type : 'schema:Book';
    if (filtersOn) {
      try {
        const release = await readRelease();
        filterReleaseKey = release.digest;
        const locale = requestLocale() ?? 'en';
        filterProperties = refinementProperties(release, type)
          .filter((property) => property.property !== 'type' && property.mode !== 'unsupported')
          .map((property) => ({
            id: property.property,
            datatype: property.datatype,
            mode: property.mode,
            labels: property.labels,
            units: property.units,
            label:
              property.labels[locale] ??
              property.labels[locale.split('-')[0]!] ??
              property.labels.en ??
              m.collection_filters(),
            ...(property.units[0] ? { unit: property.units[0] } : {}),
            ...(release.properties[property.property]?.targets
              ? { targets: release.properties[property.property]!.targets }
              : {}),
          }));
        const admission = readCollectionFilterAddress(requested, release, type);
        filter = admission.filterParams;
        filterStatus = admission.filterStatus;
      } catch {
        if (data.filterActive) filterStatus = 'failed';
      }
    }
    const page = await loadEditableCollectionPage(
      kernelClient(),
      request,
      env as Partial<SessionEnv>,
      {
        ...data,
        ...(filter?.document ? { filter: filter.document } : {}),
        ...(filterStatus ? { filterStatus } : {}),
        ...(filter ? { filterIgnored: filter.ignored, filterType: type, filterProperties, filterParams: filter } : {}),
        ...(filterReleaseKey ? { filterReleaseKey } : {}),
      },
      data.credentialMode,
    );
    await nameSubjectTypes(page.members.map((member) => member.subject));
    const release = await readRelease().catch(() => null);
    const typeRatios = release
      ? Object.fromEntries(
          Object.entries(release.types).flatMap(([id, type]) => (type.coverRatio ? [[id, type.coverRatio]] : [])),
        )
      : {};
    const listPresentations = release
      ? Object.fromEntries(
          Object.entries(release.types).flatMap(([id, type]) =>
            type.listPresentation ? [[id, type.listPresentation]] : [],
          ),
        )
      : {};
    const result = {
      ...page,
      filterActive: data.filterActive,
      typeRatios,
      listPresentations,
      ...(!('preparing' in page)
        ? {
            ...(page.visibility !== null
              ? { presentationTypes: release ? readCollectionTypeOptions(release) : null }
              : {}),
          }
        : {}),
      ...(filtersOn
        ? {
            filterProperties,
            filterParams: filter ?? { selected: {}, selectedLabels: {}, ranges: {}, ignored: [] },
            ...(filterReleaseKey ? { filterReleaseKey } : {}),
          }
        : {}),
    };
    if (data.credentialMode === 'anonymous') {
      const policy = collectionRenderPolicy(result);
      recordPublicPageCachePolicy(request, policy.cache);
      if (isPublicCacheRender(request) && policy.cache === 'public')
        setResponseHeader('cache-control', publicPageCacheControl);
      const notReady =
        'preparing' in result
          ? result.preparing || result.unavailable
          : result.memberState !== undefined && result.memberState !== 'ready';
      if (notReady && isPublicCacheRender(request)) {
        setResponseStatus(503, 'Service Unavailable');
        setResponseHeader('retry-after', '1');
      }
    }
    return result;
  });

export const readDynamicCollectionMembers = createServerFn({ method: 'GET' })
  .validator(function validateDynamicMembersInput(input: unknown) {
    if (
      !input ||
      typeof input !== 'object' ||
      !('id' in input) ||
      typeof input.id !== 'string' ||
      !input.id ||
      ('cursor' in input && input.cursor !== undefined && typeof input.cursor !== 'string') ||
      ('credentialMode' in input &&
        input.credentialMode !== undefined &&
        input.credentialMode !== 'anonymous' &&
        input.credentialMode !== 'session')
    )
      throw notFound();
    const search =
      'search' in input && input.search && typeof input.search === 'object' ? collectionFilterSearch(input.search) : {};
    return {
      id: input.id,
      credentialMode:
        'credentialMode' in input && input.credentialMode === 'anonymous'
          ? ('anonymous' as const)
          : ('session' as const),
      ...('cursor' in input && typeof input.cursor === 'string' && input.cursor ? { cursor: input.cursor } : {}),
      ...(Object.keys(search).length ? { search } : {}),
    };
  })
  .handler(async ({ data }): Promise<DynamicMembersResult> => {
    setResponseHeader('cache-control', 'private, no-store');
    let filter;
    let filterStatus: 'failed' | undefined;
    const configuredFilters = (env as { COLLECTION_FILTERS?: boolean | string }).COLLECTION_FILTERS;
    const filtersOn =
      configuredFilters === undefined
        ? import.meta.env.DEV
        : configuredFilters === true || configuredFilters === 'true';
    if (!filtersOn && hasActiveFilter(data.search)) filterStatus = 'failed';
    if (filtersOn && data.search) {
      try {
        const type = typeof data.search.type === 'string' ? data.search.type : 'schema:Book';
        const admission = readCollectionFilterAddress(data.search, await readRelease(), type);
        filter = admission.filter;
        filterStatus = admission.filterStatus;
      } catch {
        if (hasActiveFilter(data.search)) filterStatus = 'failed';
      }
    }
    const page = await loadEditableCollectionPage(
      kernelClient(),
      getRequest(),
      env as Partial<SessionEnv>,
      {
        id: data.id,
        ...(data.search ? { search: data.search } : {}),
        ...(data.cursor ? { cursor: data.cursor } : {}),
        ...(filter ? { filter } : {}),
        ...(filterStatus ? { filterStatus } : {}),
      },
      data.credentialMode,
    );
    if (!('preparing' in page)) throw notFound();
    return {
      ...(page.provenance
        ? { provenance: { ...page.provenance, request: collectionRequestVariant(data, 'members') } }
        : {}),
      members: page.members,
      next: page.next,
      preparing: page.preparing,
      retryAfterMs: page.retryAfterMs,
      unavailable: page.unavailable,
      ...(page.filterStatus ? { filterStatus: page.filterStatus } : {}),
      ...(page.cursorRestarted ? { cursorRestarted: true as const } : {}),
    };
  });

/** The route's private cache is bound to an observed viewer, request and mounted admission lifetime. */
export function viewerCollectionPageQuery(
  id: string,
  cursor: string | undefined,
  viewerId: string | null,
  search?: Record<string, string | string[]>,
  isCurrent: () => boolean = () => true,
  lifetime?: string,
) {
  const input = { id, ...(cursor ? { cursor } : {}), ...(search ? { search } : {}) };
  return queryOptions<CollectionPageResult>({
    ...personalRead,
    enabled: personalRead.enabled && Boolean(viewerId),
    retry: false,
    refetchInterval: (query) => {
      const page = query.state.data;
      return !query.state.error && page && !('preparing' in page) && page.memberState === 'preparing' && isCurrent()
        ? (page.retryAfterMs ?? 1000)
        : false;
    },
    queryKey: readQueryKey(
      ['collection-page', id, cursor ?? null, search ?? null, viewerId, lifetime ?? null],
      'session',
    ),
    queryFn: async ({ signal }) => {
      const assertCurrent = () => {
        if (!viewerId || signal.aborted || !isCurrent()) throw new Error('Collection read retired');
      };
      assertCurrent();
      const page = await readCollectionPage({ data: { ...input, credentialMode: 'session' } });
      assertCurrent();
      if (!collectionResultMatches(page, input, 'session', viewerId))
        throw new Error('Collection response does not match the current viewer and request');
      return page;
    },
  });
}

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
