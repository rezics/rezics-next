import type { KernelClient } from '@rezics/client';
import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient, requestLocale } from '../kernel/client';
import { isPlatformClosedError } from '../kernel/platform-closed';
import type { SessionEnv } from '../session/client';
import { prepareSession, viewerCredential } from '../session/request';
import { typeNames } from '../subject/definitions';
import { libraryShelfType } from './shelf-params';

export const SHELF_TYPES_LIMIT = 20;
export type ShelfTypesView =
  | { state: 'loaded'; types: { type: string; label?: string }[]; next: string | null }
  | { state: 'signed-out' | 'denied' | 'closed' | 'preparing' | 'unavailable' };

function validateTypesRead(input: unknown): { cursor?: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid Type page');
  const cursor = (input as Record<string, unknown>).cursor;
  if (cursor === undefined) return {};
  if (typeof cursor !== 'string' || !cursor || cursor.length > 4096) throw new Error('Invalid Type cursor');
  return { cursor };
}

/** One explicit owner-index request, independently authorized from chronological entries and Continue. */
export async function loadShelfTypes(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  input: { cursor?: string },
): Promise<ShelfTypesView> {
  const { cursor } = validateTypesRead(input);
  try {
    await prepareSession(request, sessionEnv);
    const authorization = viewerCredential(request);
    if (!authorization) return { state: 'signed-out' };
    const result = await client.libraryShelfTypes.get({
      query: { limit: SHELF_TYPES_LIMIT, ...(cursor ? { cursor } : {}) },
      headers: { authorization },
      fetch: { cache: 'no-store', redirect: 'manual' },
    });
    const status = result.status ?? result.error?.status;
    const value = result.error?.value;
    const code = value && typeof value === 'object' && 'code' in value ? value.code : undefined;
    if (status === 401) return { state: 'signed-out' };
    if (status === 403) return { state: code === 'platform_closed' ? 'closed' : 'denied' };
    if (status === 503) return { state: code === 'dependency_unavailable' ? 'preparing' : 'unavailable' };
    const page = result.data;
    if (
      result.error ||
      !page ||
      !Array.isArray(page.types) ||
      page.types.length > SHELF_TYPES_LIMIT ||
      page.types.some((item) => !libraryShelfType(item.type)) ||
      (page.next !== null && (typeof page.next !== 'string' || !page.next || page.next.length > 4096))
    )
      return { state: 'unavailable' };
    // Counts are native account-wide totals; this chooser deliberately omits them.
    return { state: 'loaded', types: page.types.map(({ type }) => ({ type })), next: page.next };
  } catch (error) {
    return { state: isPlatformClosedError(error) ? 'closed' : 'unavailable' };
  }
}

export const readShelfTypes = createServerFn({ method: 'GET' })
  .validator(validateTypesRead)
  .handler(async ({ data }): Promise<ShelfTypesView> => {
    setResponseHeader('cache-control', 'private, no-store');
    const page = await loadShelfTypes(kernelClient(), getRequest(), env as Partial<SessionEnv>, data);
    if (page.state !== 'loaded') return page;
    const names = await typeNames(
      page.types.map(({ type }) => type),
      requestLocale() ?? 'en',
    );
    return {
      ...page,
      types: page.types.map(({ type }) => {
        const label = names.get(type);
        return { type, ...(label ? { label } : {}) };
      }),
    };
  });
