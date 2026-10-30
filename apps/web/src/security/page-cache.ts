import { dehydrate } from '@tanstack/react-query';
import { createNonce, requestNonce } from './nonce.ts';

export const publicPageCacheControl = 'public, max-age=0, s-maxage=60';
export const pageCacheTtlSeconds = 60;
export const cachedNoncePlaceholder = '__REZICS_CACHED_PAGE_NONCE__';

type PublicCacheRoute = { staticData?: { publicCache?: boolean } };

export function isPublicCacheRoute(matches: readonly PublicCacheRoute[]): boolean {
  return matches.some((match) => match.staticData?.publicCache === true);
}

export class PublicCacheReadError extends Error {
  constructor(read: string) {
    super(`A publicCache route attempted a ${read} read during server render`);
    this.name = 'PublicCacheReadError';
  }
}

const activePublicRenders = new WeakMap<Request, number>();
const dehydratedPageData = new WeakMap<Request, unknown>();

export async function duringPublicCacheRender<T>(request: Request, render: () => Promise<T>): Promise<T> {
  activePublicRenders.set(request, (activePublicRenders.get(request) ?? 0) + 1);
  try {
    return await render();
  } finally {
    const depth = activePublicRenders.get(request) ?? 1;
    if (depth <= 1) activePublicRenders.delete(request);
    else activePublicRenders.set(request, depth - 1);
  }
}

export function assertPublicCacheReadAllowed(request: Request, read: string): void {
  if ((activePublicRenders.get(request) ?? 0) > 0) throw new PublicCacheReadError(read);
}

export function isPublicCacheRender(request: Request): boolean {
  return (activePublicRenders.get(request) ?? 0) > 0;
}

export function recordDehydratedPageData(request: Request, data: unknown): void {
  if (isPublicCacheRender(request)) dehydratedPageData.set(request, data);
}

export function consumeDehydratedPageData(request: Request): unknown {
  const data = dehydratedPageData.get(request);
  dehydratedPageData.delete(request);
  return data ?? null;
}

export function dehydratedPageDataFromRouter(router: unknown): unknown {
  const current = router as {
    stores?: { matches?: { get: () => Array<Record<string, unknown>> } };
    options?: { context?: { queryClient?: Parameters<typeof dehydrate>[0] } };
  };
  const matches = (current.stores?.matches?.get() ?? []).map((match) => ({
    id: match.id,
    routeId: match.routeId,
    status: match.status,
    params: match.params,
    search: match.search,
    loaderData: match.loaderData,
    beforeLoadContext: match.__beforeLoadContext,
    ssr: match.ssr,
  }));
  const queryClient = current.options?.context?.queryClient;
  return { matches, queries: queryClient ? dehydrate(queryClient).queries : [] };
}

export async function createPageEtag(url: string, buildId: string, dehydratedData: unknown): Promise<string> {
  const source = stableJson([buildId, url, dehydratedData]);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source));
  const binary = String.fromCharCode(...new Uint8Array(digest));
  const hash = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `W/"${hash}"`;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`;
  const toJson = (value as { toJSON?: () => unknown }).toJSON;
  if (typeof toJson === 'function') return stableJson(toJson.call(value));
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined && typeof item !== 'function' && typeof item !== 'symbol')
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
}

export interface PageCacheApi {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
}

export interface CachePublicPageOptions {
  publicRoute: boolean;
  cache?: PageCacheApi;
  buildId: string;
  dehydratedData: () => unknown;
  freshNonce?: () => string;
  render: () => Promise<Response>;
}

export async function cachePublicPage(request: Request, options: CachePublicPageOptions): Promise<Response> {
  if (!options.publicRoute) return options.render();

  return duringPublicCacheRender(request, async () => {
    if (!isPublicPageGetRequest(request)) return options.render();
    const eligible = isPageCacheRequest(request);
    const key = pageCacheKey(request);
    let cached: Response | undefined;
    if (eligible && options.cache) {
      try {
        cached = await options.cache.match(key);
      } catch {
        // A Cache API outage leaves the normal request path available.
      }
    }
    if (cached) {
      if (matchesIfNoneMatch(request.headers.get('if-none-match'), cached.headers.get('etag')))
        return notModified(cached);
      return rewriteNonce(cached, (options.freshNonce ?? (() => createNonce(request)))());
    }

    const response = await options.render();
    if (response.headers.has('set-cookie')) return privateNoStore(response);
    if (isCollectionNotFound(request, response)) return privateNoStore(response);
    if (!isPublicCacheableResponse(response)) return response;

    const etag = await createPageEtag(request.url, options.buildId, options.dehydratedData());
    const headed = withHeaders(response, (headers) => {
      headers.set('cache-control', publicPageCacheControl);
      headers.set('etag', etag);
    });
    if (eligible && options.cache) {
      try {
        const stored = await rewriteNonce(headed.clone(), cachedNoncePlaceholder);
        await options.cache.put(key, stored);
      } catch {
        // Rendering succeeds even if the shared edge cache cannot store this response.
      }
    }
    if (matchesIfNoneMatch(request.headers.get('if-none-match'), etag)) return notModified(headed);

    const nonce = (options.freshNonce ?? (() => requestNonce(request) ?? createNonce(request)))();
    return rewriteNonce(headed, nonce);
  });
}

export function pageCacheKey(request: Request): Request {
  return new Request(request.url, { method: 'GET' });
}

export function isPageCacheRequest(request: Request): boolean {
  return isPublicPageGetRequest(request) && !request.headers.has('cookie') && !request.headers.has('authorization');
}

function isPublicPageGetRequest(request: Request): boolean {
  if (request.method !== 'GET') return false;
  const { pathname } = new URL(request.url);
  if (
    pathname.startsWith('/_serverFn/') ||
    pathname === '/_serverFn' ||
    pathname === '/checkout' ||
    pathname.startsWith('/checkout/') ||
    pathname === '/media' ||
    pathname.startsWith('/media/') ||
    pathname === '/auth' ||
    pathname.startsWith('/auth/') ||
    pathname === '/api' ||
    pathname.startsWith('/api/')
  )
    return false;
  return true;
}

export function isPublicCacheableResponse(response: Response): boolean {
  return (
    (response.status === 200 || response.status === 404) &&
    response.headers.get('content-type')?.toLowerCase().includes('text/html') === true
  );
}

export function privateServerFunctionResponse(response: Response): Response {
  return withHeaders(response, (headers) => headers.set('cache-control', 'private, no-store'));
}

function privateNoStore(response: Response): Response {
  return withHeaders(response, (headers) => headers.set('cache-control', 'private, no-store'));
}

function isCollectionNotFound(request: Request, response: Response): boolean {
  return response.status === 404 && /(?:^|\/)collections\/[^/]+\/?$/u.test(new URL(request.url).pathname);
}

function withHeaders(response: Response, update: (headers: Headers) => void): Response {
  const headers = new Headers(response.headers);
  update(headers);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function matchesIfNoneMatch(value: string | null, etag: string | null): boolean {
  if (!value || !etag) return false;
  if (value.trim() === '*') return true;
  const opaqueTag = etag.replace(/^W\//, '');
  return value
    .split(',')
    .map((candidate) => candidate.trim().replace(/^W\//, ''))
    .includes(opaqueTag);
}

function notModified(response: Response): Response {
  const headers = new Headers();
  const etag = response.headers.get('etag');
  const cacheControl = response.headers.get('cache-control');
  if (etag) headers.set('etag', etag);
  if (cacheControl) headers.set('cache-control', cacheControl);
  return new Response(null, { status: 304, headers });
}

async function rewriteNonce(response: Response, nonce: string): Promise<Response> {
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  const csp = headers.get('content-security-policy');
  if (csp) headers.set('content-security-policy', csp.replace(/nonce-[^'"\s;]+/g, `nonce-${nonce}`));
  const source = new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
  return await new HTMLRewriter()
    .on('[nonce]', {
      element(element) {
        element.setAttribute('nonce', nonce);
      },
    })
    .on('meta[property="csp-nonce"]', {
      element(element) {
        element.setAttribute('content', nonce);
      },
    })
    .transform(source);
}
