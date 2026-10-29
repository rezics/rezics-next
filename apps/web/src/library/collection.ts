import { queryOptions } from '@tanstack/react-query';
import { createServerFn } from '@tanstack/react-start';
import { notFound } from '@tanstack/react-router';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { nameSubjectTypes } from '../subject/definitions';
import { kernelClient } from '../kernel/client';
import { publicRead, readQueryKey } from '../kernel/query';
import type { ReadCredentialMode } from '../kernel/credential';
import type { SessionEnv } from '../session/client';
import { loadEditableCollectionPage, loadDynamicMembers, type CollectionPageResult } from './collection-load';
import { prepareSession, viewerCredential } from '../session/request';
import { readRelease } from '../subject/definitions';
import { readCollectionFilterParams } from './collection-filter-params';
import { facetProperties } from '@rezics/filter';
import { requestLocale } from '../kernel/client';

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
    input.id.length === 0 ||
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
      if (
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

export const readCollectionPage = createServerFn({ method: 'GET' })
  .validator(validatePageInput)
  .handler(async ({ data }): Promise<CollectionPageResult> => {
    setResponseHeader('cache-control', 'private, no-store');
    const filtersOn =
      import.meta.env.DEV ||
      (env as { COLLECTION_FILTERS?: boolean | string }).COLLECTION_FILTERS === true ||
      (env as { COLLECTION_FILTERS?: string }).COLLECTION_FILTERS === 'true';
    let filter: ReturnType<typeof readCollectionFilterParams> | undefined;
    let filterProperties: { id: string; label: string; datatype: string; unit?: string }[] = [];
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
                label: labels[locale] ?? labels[locale.split('-')[0]!] ?? labels.en ?? id,
                ...(definition.units?.[0] ? { unit: definition.units[0] } : {}),
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
        /* Missing definitions leave the collection readable without an unadmitted filter. */
      }
    }
    const page = await loadEditableCollectionPage(
      kernelClient(),
      getRequest(),
      env as Partial<SessionEnv>,
      {
        ...data,
        ...(filter?.document ? { filter: filter.document } : {}),
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
    return {
      id: input.id,
      ...('cursor' in input && typeof input.cursor === 'string' && input.cursor ? { cursor: input.cursor } : {}),
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
    return loadDynamicMembers(
      kernelClient(),
      data.id,
      data.cursor,
      authorization ? { headers: { authorization } } : {},
    );
  });

export function collectionPageQuery(
  id: string,
  cursor: string | undefined,
  credentialMode: ReadCredentialMode,
  search?: Record<string, string | string[]>,
) {
  return queryOptions({
    ...publicRead,
    queryKey: readQueryKey(['collection-page', id, cursor ?? null, search ?? null], credentialMode),
    queryFn: () =>
      readCollectionPage({
        data: { id, ...(cursor === undefined ? {} : { cursor }), credentialMode, ...(search ? { search } : {}) },
      }),
  });
}
