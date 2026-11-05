import { parseEditionMetadata, type EditionMetadata } from './edition-api';

export const CREATOR_EDITIONS_PAGE_SIZE = 20;
export type CreatorEditionsSearch = { cursor?: string };
export type CreatorEditionsRouteSearch = CreatorEditionsSearch & { editionOrigin?: string };
export type CreatorEditionsPage =
  | { kind: 'ready'; editions: EditionMetadata[]; next: string | null }
  | { kind: 'sign-in' | 'denied' | 'loading' | 'unavailable' | 'stale' };
export type CreatorEditionsApi = {
  /** Declared GET /v1/accounts/:accountId/editions; accountId comes only from the native session. */
  get(
    accountId: string,
    authorization: string,
    search: CreatorEditionsSearch,
  ): Promise<{
    status: number;
    data: unknown;
  }>;
};

/** No fixture, public-offer fallback or synthetic empty page when native transport is absent. */
export const unavailableCreatorEditionsApi: CreatorEditionsApi = {
  get: async () => ({ status: 503, data: null }),
};

export function creatorEditionsSearch(value: Record<string, unknown>): CreatorEditionsSearch {
  if (value.cursor === undefined || value.cursor === '') return {};
  if (typeof value.cursor !== 'string' || value.cursor.length > 4096) throw new Error('Invalid editions cursor');
  return { cursor: value.cursor };
}

/** The return token is route browsing context; the native inventory read receives only its cursor. */
export function creatorEditionsRouteSearch(value: Record<string, unknown>): CreatorEditionsRouteSearch {
  const search = creatorEditionsSearch(value);
  const editionOrigin =
    typeof value.editionOrigin === 'string' && value.editionOrigin.length <= 64 ? value.editionOrigin : undefined;
  return { ...search, ...(editionOrigin ? { editionOrigin } : {}) };
}

/** Consumer-local binding to the declared producer route, without adding a producer module. */
export function createNativeCreatorEditionsApi(
  origin?: string,
  fetcher: typeof fetch = globalThis.fetch,
): CreatorEditionsApi {
  if (!origin) return unavailableCreatorEditionsApi;
  return {
    async get(accountId, authorization, search) {
      const url = new URL(`/v1/accounts/${encodeURIComponent(accountId)}/editions`, origin);
      url.searchParams.set('limit', String(CREATOR_EDITIONS_PAGE_SIZE));
      if (search.cursor) url.searchParams.set('cursor', search.cursor);
      const response = await fetcher(url, {
        method: 'GET',
        headers: { authorization, 'rezics-edition-identity': 'true' },
        redirect: 'manual',
        cache: 'no-store',
      });
      return { status: response.status, data: response.status === 200 ? await response.json() : null };
    },
  };
}

/** One page per deliberate navigation. A partial or empty page may still have a continuation. */
export async function loadCreatorEditions(
  api: CreatorEditionsApi,
  accountId: string,
  authorization: string,
  search: CreatorEditionsSearch,
): Promise<CreatorEditionsPage> {
  try {
    const query = creatorEditionsSearch(search);
    const result = await api.get(accountId, authorization, query);
    if (result.status === 401) return { kind: 'sign-in' };
    if (result.status === 403) return { kind: 'denied' };
    if (result.status === 400 || result.status === 409 || result.status === 412) return { kind: 'stale' };
    const page = result.data;
    if (
      result.status !== 200 ||
      !page ||
      typeof page !== 'object' ||
      Array.isArray(page) ||
      Object.keys(page).some((key) => key !== 'editions' && key !== 'next') ||
      !('editions' in page) ||
      !Array.isArray(page.editions) ||
      page.editions.length > CREATOR_EDITIONS_PAGE_SIZE ||
      !('next' in page) ||
      !(page.next === null || (typeof page.next === 'string' && page.next.length > 0 && page.next.length <= 4096)) ||
      page.next === query.cursor
    )
      return { kind: 'unavailable' };
    const editions: EditionMetadata[] = [];
    for (const row of page.editions) {
      const edition = parseEditionMetadata(row);
      if (
        !edition ||
        edition.creatorAccountId !== accountId ||
        editions.some((item) => item.editionId === edition.editionId)
      )
        return { kind: 'unavailable' };
      editions.push(edition);
    }
    return { kind: 'ready', editions, next: page.next };
  } catch {
    return { kind: 'unavailable' };
  }
}
