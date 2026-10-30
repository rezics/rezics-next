import type { KernelClient } from '@rezics/client';
import { queryOptions } from '@tanstack/react-query';
import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient } from '../kernel/client';
import { personalRead, readQueryKey } from '../kernel/query';
import type { SessionEnv } from '../session/client';
import { prepareSession, sessionSubject, viewerCredential } from '../session/request';
import { loadMineCollectionsForOwner, type MineCollection } from './mine-collections';

export type LibraryPinTarget = {
  id: string;
  title?: string | null;
  membershipKind?: 'curated' | 'dynamic';
  builtinKind?: string;
  builtinLabels?: Record<string, string>;
};

export type LibraryPin = { collectionId: string; target: LibraryPinTarget | null };
export type LibraryPinsPage = { pins: LibraryPin[]; revision: number; next: string | null };
export type LibraryPinsRead =
  | { state: 'closed' }
  | { state: 'unavailable' }
  | ({ state: 'loaded'; canUpdate?: boolean } & LibraryPinsPage);

type Result<T> = {
  data?: T | null;
  error?: { status?: number; value?: unknown } | null;
  status?: number;
};

type LibraryPinsApi = {
  openapi: {
    json: {
      get(options?: {
        headers?: { authorization: string };
        fetch?: { signal: AbortSignal };
      }): Promise<Result<{ paths?: Record<string, Record<string, { operationId?: string }>> }>>;
    };
  };
  libraryPins: {
    get(options: {
      query: { limit: number };
      headers: { authorization: string };
      fetch?: { signal: AbortSignal };
    }): Promise<Result<LibraryPinsPage>>;
  };
};

function resultStatus(result: Result<unknown>): number | undefined {
  return result.status ?? result.error?.status;
}

export function libraryPinsListExposed(document: unknown): boolean {
  if (!document || typeof document !== 'object' || !('paths' in document)) return false;
  const paths = document.paths;
  if (!paths || typeof paths !== 'object') return false;
  return Object.values(paths).some((path) => {
    if (!path || typeof path !== 'object' || !('get' in path)) return false;
    const operation = path.get;
    return (
      operation !== null &&
      typeof operation === 'object' &&
      'operationId' in operation &&
      operation.operationId === 'library_pin.list'
    );
  });
}

function libraryPinsUpdateExposed(document: unknown): boolean {
  if (!document || typeof document !== 'object' || !('paths' in document)) return false;
  const paths = document.paths;
  if (!paths || typeof paths !== 'object') return false;
  return Object.values(paths).some((path) => {
    if (!path || typeof path !== 'object') return false;
    const put = 'put' in path ? path.put : undefined;
    const remove = 'delete' in path ? path.delete : undefined;
    return (
      put !== null &&
      typeof put === 'object' &&
      'operationId' in put &&
      put.operationId === 'library_pin.put' &&
      remove !== null &&
      typeof remove === 'object' &&
      'operationId' in remove &&
      remove.operationId === 'library_pin.delete'
    );
  });
}

/** Reads one bounded pins page only when this viewer's OpenAPI view exposes the list operation. */
export async function readLibraryPins(
  client: KernelClient,
  authorization: string,
  limit: 8 | 100,
): Promise<LibraryPinsRead> {
  // The pin routes are waiting for the generated client update from commerce's library-pins runtime.
  const api = client as unknown as LibraryPinsApi;
  try {
    const exposed = await api.openapi.json.get({
      headers: { authorization },
      fetch: { signal: AbortSignal.timeout(2_000) },
    });
    if (exposed.error || !exposed.data) return { state: 'unavailable' };
    if (!libraryPinsListExposed(exposed.data)) return { state: 'closed' };

    const result = await api.libraryPins.get({
      query: { limit },
      headers: { authorization },
      fetch: { signal: AbortSignal.timeout(2_000) },
    });
    const status = resultStatus(result);
    if (result.error || (status !== undefined && status >= 400) || !result.data) return { state: 'unavailable' };
    return { state: 'loaded', ...result.data, canUpdate: libraryPinsUpdateExposed(exposed.data) };
  } catch {
    return { state: 'unavailable' };
  }
}

export type LibraryNavigationRead = {
  pins: LibraryPinsRead;
  collections: MineCollection[];
};

export async function loadLibraryNavigation(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  limit: 8 | 100 = 8,
): Promise<LibraryNavigationRead> {
  await prepareSession(request, sessionEnv);
  const authorization = viewerCredential(request);
  const accountId = sessionSubject(request);
  if (!authorization || !accountId) return { pins: { state: 'closed' }, collections: [] };
  const [pins, owner] = await Promise.all([
    readLibraryPins(client, authorization, limit),
    loadMineCollectionsForOwner(client, accountId, authorization).catch(() => undefined),
  ]);
  return { pins, collections: owner?.collections ?? [] };
}

export const readLibraryNavigationPage = createServerFn({ method: 'GET' })
  .validator((input: unknown) => (input === 100 ? 100 : 8))
  .handler(async ({ data }) => {
    setResponseHeader('cache-control', 'private, no-store');
    return loadLibraryNavigation(kernelClient(), getRequest(), env as Partial<SessionEnv>, data);
  });

/** Personal navigation reads start in the browser, after hydration. */
export function libraryNavigationQuery(locale: string, limit: 8 | 100 = 8) {
  return queryOptions({
    ...personalRead,
    enabled: personalRead.enabled,
    queryKey: readQueryKey(['library-navigation', locale, limit], 'session'),
    queryFn: () => readLibraryNavigationPage({ data: limit }),
  });
}

export const readLibraryPinsPage = createServerFn({ method: 'GET' })
  .validator((input: unknown) => (input === 100 ? 100 : 8))
  .handler(async ({ data }) => {
    setResponseHeader('cache-control', 'private, no-store');
    const request = getRequest();
    await prepareSession(request, env as Partial<SessionEnv>);
    const authorization = viewerCredential(request);
    if (!authorization) return { state: 'closed' } as const;
    return readLibraryPins(kernelClient(), authorization, data);
  });
