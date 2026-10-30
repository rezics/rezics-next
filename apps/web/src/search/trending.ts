import { createServerOnlyFn } from '@tanstack/react-start';
import type { KernelClient } from '@rezics/client';
import { useEffect, useState } from 'react';
import { problem, problemResponse } from '../media/kernel';
import { isPlatformClosedError } from '../kernel/platform-closed';
import type { SessionEnv } from '../session/client';

export type TrendingPage = NonNullable<Awaited<ReturnType<KernelClient['trendingSearches']['get']>>['data']>;
export type TrendingState =
  | { status: 'loading' | 'preparing' | 'unavailable' }
  | { status: 'ready'; page: TrendingPage };

/** The actual typed API, carrying the current BFF credential exactly once, with no anonymous retry. */
export async function readTrendingSearches(
  client: KernelClient,
  language: string,
  credential: string | null,
  signal: AbortSignal,
): Promise<TrendingPage> {
  signal.throwIfAborted();
  const result = await client.trendingSearches.get({
    query: { language, limit: 10 },
    headers: credential === null ? {} : { authorization: credential },
    fetch: { signal },
  });
  signal.throwIfAborted();
  if (result.error) {
    const code = (result.error.value as { code?: unknown }).code;
    throw problem(
      result.status,
      typeof code === 'string' ? code : 'dependency_unavailable',
      'Trending searches unavailable',
    );
  }
  return result.data;
}
const read = createServerOnlyFn(async (request: Request): Promise<TrendingPage> => {
  const [{ kernelClient }, { viewerCredential }] = await Promise.all([
    import('../kernel/client'),
    import('../session/request'),
  ]);
  const language = new URL(request.url).searchParams.get('language') ?? '';
  if (language.length > 35 || !/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(language))
    throw problem(400, 'invalid_request', 'Invalid language');
  return readTrendingSearches(kernelClient(language), language, viewerCredential(request), request.signal);
});
export async function trendingResponse(request: Request, env: Partial<SessionEnv>, load = read): Promise<Response> {
  if (request.method !== 'GET') return new Response(null, { status: 405, headers: { allow: 'GET' } });
  try {
    const [{ prepareSession, viewerCredential }, { carriesSession }] = await Promise.all([
      import('../session/request'),
      import('../session/csrf'),
    ]);
    if (await prepareSession(request, env)) throw problem(401, 'invalid_credentials', 'Sign in again');
    if (carriesSession(request) && !viewerCredential(request))
      throw problem(503, 'dependency_unavailable', 'Session unavailable');
    return Response.json(await load(request), { headers: { 'cache-control': 'private, no-store' } });
  } catch (error) {
    return problemResponse(isPlatformClosedError(error) ? problem(403, 'platform_closed', 'Not open yet') : error);
  }
}

/** Reopening mounts a new request. Identity/language changes hide the old response before effects run. */
export function useTrendingSearches(language: string, identity: string | null): TrendingState {
  const key = JSON.stringify([language, identity]);
  const [snapshot, setSnapshot] = useState<{ key: string; state: TrendingState }>();
  useEffect(() => {
    if (identity === null) return;
    const controller = new AbortController();
    const settle = (state: TrendingState) => {
      if (!controller.signal.aborted) setSnapshot({ key, state });
    };
    settle({ status: 'loading' });
    void fetch(`/api/search/trending?language=${encodeURIComponent(language)}`, {
      credentials: 'same-origin',
      cache: 'no-store',
      signal: controller.signal,
    })
      .then(async (response) => {
        const body = (await response.json()) as TrendingPage & { code?: string };
        if (!response.ok)
          return settle({
            status: body.code === 'semantic_not_ready' || body.code === 'index_not_ready' ? 'preparing' : 'unavailable',
          });
        if (!validTrendingPage(body)) return settle({ status: 'unavailable' });
        settle({ status: 'ready', page: body });
      })
      .catch(() => settle({ status: 'unavailable' }));
    return () => controller.abort();
  }, [key, language, identity]);
  return identity === null ? { status: 'unavailable' } : snapshot?.key === key ? snapshot.state : { status: 'loading' };
}
export function validTrendingPage(value: unknown): value is TrendingPage {
  if (!value || typeof value !== 'object') return false;
  const body = value as TrendingPage;
  return (
    body.next === null &&
    Array.isArray(body.trendingSearches) &&
    body.trendingSearches.length <= 10 &&
    body.trendingSearches.every(
      (term) =>
        term &&
        typeof term.query === 'string' &&
        typeof term.display === 'string' &&
        term.query.length <= 1024 &&
        term.display.length > 0 &&
        term.display.length <= 256 &&
        Object.keys(term).every((key) => key === 'query' || key === 'display'),
    )
  );
}
