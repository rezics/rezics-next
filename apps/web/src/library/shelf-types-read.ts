import type { KernelClient } from '@rezics/client';
import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient, requestLocale } from '../kernel/client';
import { isPlatformClosedError } from '../kernel/platform-closed';
import type { SessionEnv } from '../session/client';
import { prepareSession, sessionSubject, viewerCredential } from '../session/request';
import { typeNames } from '../subject/definitions';
import { libraryShelfType } from './shelf-params';
import { SHELF_TYPES_LIMIT, type ShelfTypesCurrentRead, type ShelfTypesView } from './settings-contract';

export { SHELF_TYPES_LIMIT, type ShelfTypesCurrentRead, type ShelfTypesView };

function validateTypesRead(input: unknown): { cursor?: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid Type page');
  const cursor = (input as Record<string, unknown>).cursor;
  if (cursor === undefined) return {};
  if (typeof cursor !== 'string' || !cursor || cursor.length > 4096) throw new Error('Invalid Type cursor');
  return { cursor };
}

/** One preparation on the same Request as the credential used by the one native owner-index GET. */
async function loadTypes(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  input: { cursor?: string },
  current: boolean,
  names = false,
): Promise<ShelfTypesCurrentRead> {
  const { cursor } = validateTypesRead(input);
  const locale = requestLocale(request) ?? 'en';
  const provenance: Omit<ShelfTypesCurrentRead, 'page'> = {
    sessionSubject: null,
    authorizationAgrees: false,
    requested: { cursor: cursor ?? null, limit: SHELF_TYPES_LIMIT, locale },
  };
  let authorization: string | null = null;
  const agrees = () =>
    !!provenance.sessionSubject &&
    !request.headers.has('authorization') &&
    sessionSubject(request) === provenance.sessionSubject &&
    viewerCredential(request) === authorization;
  const result = (page: ShelfTypesView): ShelfTypesCurrentRead => {
    provenance.authorizationAgrees = authorization !== null && agrees();
    return {
      ...provenance,
      page: current && page.state === 'loaded' && !provenance.authorizationAgrees ? { state: 'unavailable' } : page,
    };
  };
  try {
    if (await prepareSession(request, sessionEnv)) return result({ state: 'signed-out' });
    authorization = viewerCredential(request);
    if (!authorization) return result({ state: 'signed-out' });
    provenance.sessionSubject = sessionSubject(request) ?? null;
    // An explicit bearer has no prepared session identity agreement. Pure legacy readers still support it.
    if (current && !agrees()) return result({ state: 'unavailable' });
    const response = await client.libraryShelfTypes.get({
      query: { limit: SHELF_TYPES_LIMIT, ...(cursor ? { cursor } : {}) },
      headers: { authorization },
      fetch: { cache: 'no-store', redirect: 'manual' },
    });
    if (current && !agrees()) return result({ state: 'unavailable' });
    const status = response.status ?? response.error?.status;
    const value = response.error?.value;
    const code = value && typeof value === 'object' && 'code' in value ? value.code : undefined;
    if (status === 401) return result({ state: 'signed-out' });
    if (status === 403) return result({ state: code === 'platform_closed' ? 'closed' : 'denied' });
    if (status === 503) return result({ state: code === 'dependency_unavailable' ? 'preparing' : 'unavailable' });
    const page = response.data;
    if (
      response.error ||
      !page ||
      !Array.isArray(page.types) ||
      page.types.length > SHELF_TYPES_LIMIT ||
      page.types.some((item) => !libraryShelfType(item.type)) ||
      (page.next !== null && (typeof page.next !== 'string' || !page.next || page.next.length > 4096))
    )
      return result({ state: 'unavailable' });
    // Counts are native account-wide totals; this chooser deliberately omits them.
    const types = page.types.map(({ type }) => ({ type }));
    let labels = new Map<string, string>();
    if (names) {
      try {
        labels = await typeNames(
          types.map(({ type }) => type),
          locale,
        );
      } catch {
        // Optional names cannot turn a failed definition read into new Type/count facts.
      }
      if (current && !agrees()) return result({ state: 'unavailable' });
    }
    return result({
      state: 'loaded',
      types: types.map(({ type }) => {
        const label = labels.get(type);
        return { type, ...(label ? { label } : {}) };
      }),
      next: page.next,
    });
  } catch (error) {
    return result({ state: isPlatformClosedError(error) ? 'closed' : 'unavailable' });
  }
}

/** Pure result compatibility for existing native/server callers. */
export async function loadShelfTypes(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  input: { cursor?: string },
): Promise<ShelfTypesView> {
  return (await loadTypes(client, request, sessionEnv, input, false)).page;
}

export async function loadShelfTypesCurrent(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  input: { cursor?: string },
): Promise<ShelfTypesCurrentRead> {
  return loadTypes(client, request, sessionEnv, input, true, true);
}

export const readShelfTypes = createServerFn({ method: 'GET' })
  .validator(validateTypesRead)
  .handler(async ({ data }): Promise<ShelfTypesView> => {
    setResponseHeader('cache-control', 'private, no-store');
    return (await loadTypes(kernelClient(), getRequest(), env as Partial<SessionEnv>, data, false, true)).page;
  });

export const readShelfTypesCurrent = createServerFn({ method: 'GET' })
  .validator(validateTypesRead)
  .handler(async ({ data }): Promise<ShelfTypesCurrentRead> => {
    setResponseHeader('cache-control', 'private, no-store');
    const request = getRequest();
    return loadShelfTypesCurrent(kernelClient(requestLocale(request)), request, env as Partial<SessionEnv>, data);
  });
