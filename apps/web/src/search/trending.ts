import { createServerOnlyFn } from '@tanstack/react-start';
import type { KernelClient } from '@rezics/client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { problem, problemResponse } from '../media/kernel';
import { isPlatformClosedError } from '../kernel/platform-closed';
import type { SessionEnv } from '../session/client';
import { searchRetryAt } from './search-recovery-retry';

export type TrendingPage = NonNullable<Awaited<ReturnType<KernelClient['trendingSearches']['get']>>['data']>;
export type TrendingState =
  | { status: 'loading' | 'preparing' | 'unavailable'; retryAt?: number }
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
    const failure = problem(
      result.status,
      typeof code === 'string' ? code : 'dependency_unavailable',
      'Trending searches unavailable',
    );
    const retryAfter = new Headers(result.headers).get('retry-after');
    if (retryAfter !== null) throw Object.assign(failure, { headers: { 'retry-after': retryAfter } });
    throw failure;
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

/** Session observations retire requests synchronously, including batched A-B-A transitions. */
export function useTrendingSearches(
  language: string,
  identity: string | null,
  observeIdentity: (retire: () => void) => () => void,
) {
  const [epoch, setEpoch] = useState(0);
  const key = JSON.stringify([language, identity, epoch]);
  const currentKey = useRef<string | null>(key);
  currentKey.current = key;
  const active = useRef<{ key: string; controller: AbortController; state: TrendingState; pending: boolean }>(null);
  const [snapshot, setSnapshot] = useState<{ key: string; state: TrendingState }>();
  useEffect(
    () =>
      observeIdentity(() => {
        currentKey.current = null;
        active.current?.controller.abort();
        setEpoch((value) => value + 1);
      }),
    [observeIdentity],
  );
  const start = useCallback(
    (manual: boolean) => {
      if (identity === null || currentKey.current !== key) return;
      const previous = active.current;
      if (
        manual &&
        (!previous ||
          previous.key !== key ||
          previous.pending ||
          !['preparing', 'unavailable'].includes(previous.state.status) ||
          (previous.state.status !== 'ready' && (previous.state.retryAt ?? 0) > Date.now()))
      )
        return;
      previous?.controller.abort();
      const request = {
        key,
        controller: new AbortController(),
        state: { status: 'loading' } as TrendingState,
        pending: true,
      };
      active.current = request;
      const { controller } = request;
      const settle = (state: TrendingState) => {
        if (controller.signal.aborted || currentKey.current !== key || active.current !== request) return;
        request.state = state;
        request.pending = false;
        setSnapshot({ key, state });
      };
      setSnapshot({ key, state: request.state });
      void fetch(`/api/search/trending?language=${encodeURIComponent(language)}`, {
        credentials: 'same-origin',
        cache: 'no-store',
        signal: controller.signal,
      })
        .then(async (response) => {
          const retryAt = searchRetryAt(response.headers.get('retry-after'), Date.now());
          const body: unknown = await response.json().catch(() => null);
          if (!response.ok) {
            const code = body && typeof body === 'object' && 'code' in body ? body.code : undefined;
            return settle({
              status: code === 'semantic_not_ready' || code === 'index_not_ready' ? 'preparing' : 'unavailable',
              ...(retryAt !== undefined ? { retryAt } : {}),
            });
          }
          if (!validTrendingPage(body)) return settle({ status: 'unavailable' });
          settle({ status: 'ready', page: body });
        })
        .catch(() => settle({ status: 'unavailable' }));
    },
    [identity, key, language],
  );
  useEffect(() => {
    start(false);
    return () => {
      if (active.current?.key === key) active.current.controller.abort();
    };
  }, [key, start]);
  const state: TrendingState =
    identity === null ? { status: 'unavailable' } : snapshot?.key === key ? snapshot.state : { status: 'loading' };
  return { state, retry: () => start(true), isCurrent: () => identity !== null && currentKey.current === key };
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
