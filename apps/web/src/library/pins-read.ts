import type { KernelClient } from '@rezics/client';
import { queryOptions } from '@tanstack/react-query';
import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient } from '../kernel/client';
import { isPlatformClosedError, isPlatformClosedProblem } from '../kernel/platform-closed';
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
/** Public provenance of one actual prepared read; credentials never leave the server. */
export type LibraryPinsOrigin = {
  sessionSubject: string | null;
  credentialAgrees: boolean;
  requestedLimit: 8 | 100;
};
export type LibraryPinsRead = (
  | { state: 'closed'; platformClosed?: true }
  | { state: 'preparing' }
  | { state: 'denied' }
  | { state: 'unavailable' }
  | ({ state: 'loaded'; canUpdate?: boolean; canRemove?: boolean } & LibraryPinsPage)
) & { origin?: LibraryPinsOrigin };

type Result<T> = {
  data?: T | null;
  error?: { status?: number; value?: unknown } | null;
  status?: number;
};

function resultStatus(result: Result<unknown>): number | undefined {
  return result.status ?? result.error?.status;
}

function resultRefusal(result: Result<unknown>): LibraryPinsRead | undefined {
  const status = resultStatus(result);
  if (isPlatformClosedProblem(status, result.error?.value)) return { state: 'closed', platformClosed: true };
  if (status === 403) return { state: 'denied' };
  if (status === 202) return { state: 'preparing' };
  return undefined;
}

function isTransportFailure(error: unknown): boolean {
  return (
    error instanceof TypeError ||
    (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError'))
  );
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

function pinOperationExposed(document: unknown, method: 'put' | 'delete'): boolean {
  if (!document || typeof document !== 'object' || !('paths' in document)) return false;
  const paths = document.paths;
  if (!paths || typeof paths !== 'object') return false;
  return Object.values(paths).some((path) => {
    if (!path || typeof path !== 'object') return false;
    const operation: unknown =
      method === 'put' ? ('put' in path ? path.put : undefined) : 'delete' in path ? path.delete : undefined;
    return (
      operation !== null &&
      typeof operation === 'object' &&
      'operationId' in operation &&
      operation.operationId === `library_pin.${method}`
    );
  });
}

/** Use only after the owning reader has prepared this exact Request. */
export function preparedPinsOrigin(request: Request, limit: 8 | 100): LibraryPinsOrigin {
  const subject = sessionSubject(request);
  return {
    sessionSubject: subject ?? null,
    // An explicit bearer is not evidence that it belongs to a cached session subject.
    credentialAgrees: !!subject && !!viewerCredential(request) && !request.headers.has('authorization'),
    requestedLimit: limit,
  };
}

/** Reads pins under the owner's existing preparation, without preparing another session. */
export async function readPreparedLibraryPins(
  client: KernelClient,
  request: Request,
  limit: 8 | 100,
): Promise<LibraryPinsRead> {
  const origin = preparedPinsOrigin(request, limit);
  const authorization = viewerCredential(request);
  if (!origin.credentialAgrees || !authorization) return { state: 'closed', origin };
  const current = () =>
    sessionSubject(request) === origin.sessionSubject && viewerCredential(request) === authorization;
  const pins = await readLibraryPins(client, authorization, limit, current);
  return current() ? { ...pins, origin } : { state: 'closed', origin: { ...origin, credentialAgrees: false } };
}

/** Reads one bounded pins page only when this viewer's OpenAPI view exposes the list operation. */
export async function readLibraryPins(
  client: KernelClient,
  authorization: string,
  limit: 8 | 100,
  isCurrent: () => boolean = () => true,
): Promise<LibraryPinsRead> {
  try {
    if (!isCurrent()) return { state: 'closed' };
    const exposed = await client['openapi.json'].get({
      headers: { authorization },
      fetch: { cache: 'no-store', redirect: 'manual', signal: AbortSignal.timeout(2_000) },
    });
    if (!isCurrent()) return { state: 'closed' };
    const openApiRefusal = resultRefusal(exposed);
    if (openApiRefusal) return openApiRefusal;
    if (exposed.error || !exposed.data) return { state: 'unavailable' };
    if (!libraryPinsListExposed(exposed.data)) return { state: 'closed' };

    const result = await client.libraryPins.get({
      query: { limit },
      headers: { authorization },
      fetch: { cache: 'no-store', redirect: 'manual', signal: AbortSignal.timeout(2_000) },
    });
    const listRefusal = resultRefusal(result);
    if (listRefusal) return listRefusal;
    const status = resultStatus(result);
    if (result.error || (status !== undefined && status >= 400) || !result.data) return { state: 'unavailable' };
    return {
      state: 'loaded',
      ...result.data,
      canUpdate: pinOperationExposed(exposed.data, 'put'),
      canRemove: pinOperationExposed(exposed.data, 'delete'),
    };
  } catch (error) {
    if (isPlatformClosedError(error)) return { state: 'closed', platformClosed: true };
    if (isTransportFailure(error)) return { state: 'unavailable' };
    throw error;
  }
}

export type LibraryNavigationRead = {
  origin?: LibraryPinsOrigin;
  pins: LibraryPinsRead;
  collections: MineCollection[];
  collectionsState?: 'loaded' | 'unavailable' | 'preparing';
};

export async function loadLibraryNavigation(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  limit: 8 | 100 = 8,
  reads = { pins: true, collections: true },
): Promise<LibraryNavigationRead> {
  const refused = await prepareSession(request, sessionEnv);
  const prepared = preparedPinsOrigin(request, limit);
  const origin = refused ? { ...prepared, sessionSubject: null, credentialAgrees: false } : prepared;
  const closed: LibraryNavigationRead = {
    origin,
    pins: { state: 'closed', origin },
    collections: [],
    collectionsState: 'loaded',
  };
  const authorization = viewerCredential(request);
  const accountId = origin.sessionSubject;
  if (!origin.credentialAgrees || !authorization || !accountId) return closed;
  const [pins, owner] = await Promise.all([
    reads.pins ? readPreparedLibraryPins(client, request, limit) : { state: 'closed' as const, origin },
    reads.collections
      ? loadMineCollectionsForOwner(client, accountId, authorization).catch(() => undefined)
      : undefined,
  ]);
  if (sessionSubject(request) !== accountId || viewerCredential(request) !== authorization) {
    const refusedOrigin = { ...origin, credentialAgrees: false };
    return { ...closed, origin: refusedOrigin, pins: { state: 'closed', origin: refusedOrigin } };
  }
  return {
    origin,
    pins,
    collections: owner?.collections ?? [],
    collectionsState:
      !reads.collections || (owner && (!owner.state || owner.state === 'loaded'))
        ? 'loaded'
        : owner?.state === 'preparing'
          ? 'preparing'
          : 'unavailable',
  };
}

type NavigationInput = { limit: 8 | 100; pins: boolean; collections: boolean };
function navigationInput(input: unknown): NavigationInput {
  if (input && typeof input === 'object') {
    const value = input as Partial<NavigationInput>;
    return {
      limit: value.limit === 100 ? 100 : 8,
      pins: value.pins !== false,
      collections: value.collections !== false,
    };
  }
  return { limit: input === 100 ? 100 : 8, pins: true, collections: true };
}

export const readLibraryNavigationPage = createServerFn({ method: 'GET' })
  .validator(navigationInput)
  .handler(async ({ data }) => {
    setResponseHeader('cache-control', 'private, no-store');
    return loadLibraryNavigation(kernelClient(), getRequest(), env as Partial<SessionEnv>, data.limit, data);
  });

/** Personal navigation reads start in the browser, after hydration. */
export type LibraryNavigationAdmission = {
  subject: string;
  lifetime: string;
  pins: boolean;
  collections: boolean;
  isCurrent: () => boolean;
};
export function libraryNavigationQuery(locale: string, limit: 8 | 100 = 8, admission?: LibraryNavigationAdmission) {
  return queryOptions({
    ...personalRead,
    enabled: personalRead.enabled && (!admission || admission.pins || admission.collections),
    queryKey: readQueryKey(
      ['library-navigation', locale, limit, ...(admission ? [admission.subject, admission.lifetime] : [])],
      'session',
    ),
    queryFn: async () => {
      if (admission && !admission.isCurrent()) throw new Error('Retired Library navigation');
      const value = await readLibraryNavigationPage({
        data: admission ? { limit, pins: admission.pins, collections: admission.collections } : limit,
      });
      if (
        admission &&
        (!admission.isCurrent() ||
          !matchesPinsOrigin(value.origin, admission.subject, limit) ||
          (admission.pins && !matchesPinsOrigin(value.pins.origin, admission.subject, limit)))
      )
        throw new Error('Unaccepted Library navigation origin');
      return value;
    },
    ...(admission ? { gcTime: 0, retry: false, refetchOnWindowFocus: false, refetchOnReconnect: false } : {}),
  });
}

export const readLibraryPinsPage = createServerFn({ method: 'GET' })
  .validator((input: unknown) => (input === 100 ? 100 : 8))
  .handler(async ({ data }) => {
    setResponseHeader('cache-control', 'private, no-store');
    const request = getRequest();
    if (await prepareSession(request, env as Partial<SessionEnv>))
      return {
        state: 'closed',
        origin: { sessionSubject: null, credentialAgrees: false, requestedLimit: data },
      } as const;
    return readPreparedLibraryPins(kernelClient(), request, data);
  });

export function matchesPinsOrigin(origin: LibraryPinsOrigin | undefined, subject: string, limit: 8 | 100): boolean {
  return origin?.sessionSubject === subject && origin.credentialAgrees && origin.requestedLimit === limit;
}
