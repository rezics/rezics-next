import type { KernelClient } from '@rezics/client';
import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient, requestLocale } from '../kernel/client';
import { isPlatformClosedError } from '../kernel/platform-closed';
import type { SessionEnv } from '../session/client';
import { prepareSession, sessionSubject, viewerCredential } from '../session/request';
import { libraryShelfType } from './shelf-params';

// Derive the receiving shape from the installed publisher, without a parallel wire declaration.
export type ShelfSummary = NonNullable<Awaited<ReturnType<KernelClient['libraryShelfSummary']['get']>>['data']>;
export const shelfSummaryTabs = ['all', 'in_progress', 'planned', 'completed', 'paused', 'dropped', 'collections'] as const;
export type ShelfSummaryView =
  | { state: 'loaded'; summary: ShelfSummary }
  | { state: 'signed-out' | 'closed' | 'denied' | 'preparing' | 'unavailable' };
export type ShelfSummaryCurrentRead = {
  sessionSubject: string | null;
  authorizationAgrees: boolean;
  requested: { type: string | null; locale: string; source: string };
  page: ShelfSummaryView;
};

export function validateShelfSummaryInput(input: unknown): { type?: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid Library summary');
  const type = (input as Record<string, unknown>).type;
  if (type === undefined) return {};
  const normalized = libraryShelfType(type);
  if (!normalized) throw new Error('Invalid Library summary Type');
  return { type: normalized };
}

/** Validate omission separately from actual native zero, including cross-tab invariants. */
export function validShelfSummary(value: unknown, type?: string): value is ShelfSummary {
  if (!value || typeof value !== 'object' || !('tabs' in value)) return false;
  const tabs = value.tabs;
  if (!tabs || typeof tabs !== 'object') return false;
  const counts: { total: number; shown: number }[] = [];
  for (const key of shelfSummaryTabs) {
    if (!(key in tabs)) return false;
    const count: unknown = Reflect.get(tabs, key);
    if (!count || typeof count !== 'object' || !('total' in count) || !('shown' in count)) return false;
    const { total, shown } = count;
    if (typeof total !== 'number' || typeof shown !== 'number' ||
        !Number.isSafeInteger(total) || !Number.isSafeInteger(shown) || shown < 0 || total < shown ||
        ((!type || key === 'collections') && total !== shown)) return false;
    counts.push({ total, shown });
  }
  const all = counts[0]!;
  // Custom states are included only in all; legacy buckets need not exhaust it.
  const legacy = counts.slice(1, 6);
  return legacy.reduce((sum, count) => sum + count.total, 0) <= all.total &&
    legacy.reduce((sum, count) => sum + count.shown, 0) <= all.shown;
}

/** One native GET; the caller owns retirement of this independent admitted observation. */
export async function loadShelfSummaryCurrent(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  input: { type?: string },
): Promise<ShelfSummaryCurrentRead> {
  const { type } = validateShelfSummaryInput(input);
  const provenance = {
    sessionSubject: null as string | null,
    authorizationAgrees: false,
    requested: { type: type ?? null, locale: requestLocale(request) ?? 'en', source: request.url },
  };
  let authorization: string | null = null;
  const agrees = () => !!provenance.sessionSubject && !request.headers.has('authorization') &&
    sessionSubject(request) === provenance.sessionSubject && viewerCredential(request) === authorization;
  const result = (page: ShelfSummaryView): ShelfSummaryCurrentRead => {
    provenance.authorizationAgrees = authorization !== null && agrees();
    return { ...provenance, page: page.state === 'loaded' && !provenance.authorizationAgrees
      ? { state: 'unavailable' } : page };
  };
  try {
    if (await prepareSession(request, sessionEnv)) return result({ state: 'signed-out' });
    authorization = viewerCredential(request);
    if (!authorization) return result({ state: 'signed-out' });
    provenance.sessionSubject = sessionSubject(request) ?? null;
    if (!agrees()) return result({ state: 'unavailable' });
    const response = await client.libraryShelfSummary.get({
      query: type ? { type } : {},
      headers: { authorization },
      fetch: { cache: 'no-store', redirect: 'manual' },
    });
    if (!agrees()) return result({ state: 'unavailable' });
    const status = response.status ?? response.error?.status;
    const value = response.error?.value;
    const code = value && typeof value === 'object' && 'code' in value ? value.code : undefined;
    if (status === 401) return result({ state: 'signed-out' });
    if (status === 403) return result({ state: code === 'platform_closed' ? 'closed' : 'denied' });
    if (status === 503) return result({ state: code === 'dependency_unavailable' ? 'preparing' : 'unavailable' });
    if (response.error || !validShelfSummary(response.data, type)) return result({ state: 'unavailable' });
    return result({ state: 'loaded', summary: response.data });
  } catch (error) {
    return result({ state: isPlatformClosedError(error) ? 'closed' : 'unavailable' });
  }
}

export const readShelfSummaryCurrent = createServerFn({ method: 'GET' })
  .validator(validateShelfSummaryInput)
  .handler(async ({ data }): Promise<ShelfSummaryCurrentRead> => {
    setResponseHeader('cache-control', 'private, no-store');
    const request = getRequest();
    return loadShelfSummaryCurrent(kernelClient(requestLocale(request)), request, env as Partial<SessionEnv>, data);
  });
