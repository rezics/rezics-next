import { dehydrate } from '@tanstack/react-query';
import { createNonce, requestNonce } from './nonce.ts';

export const publicPageCacheControl = 'public, max-age=0, s-maxage=0, must-revalidate';
export const pageCacheTtlSeconds = 60;
// Internal retention only. This header must never authorize an HTTP client to skip revalidation.
const storedPageCacheControl = `public, max-age=0, s-maxage=${pageCacheTtlSeconds}`;
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
const privatePageReads = new WeakSet<Request>();

/** Preserve restrictive native read caching through SSR. */
export function recordPageReadCacheControl(request: Request, cacheControl: string | null): void {
  if (cacheControl?.split(',').some((directive) => /^(?:private|no-store)(?:=|$)/i.test(directive.trim())))
    privatePageReads.add(request);
}

const publicPageFailures = new WeakMap<Request, number>();
const publicPagePolicies = new WeakMap<Request, 'public' | 'private'>();

/** A Collection result must explicitly authorize public HTML caching after native disclosure. */
export function recordPublicPageCachePolicy(request: Request, policy: 'public' | 'private'): void {
  if (isPublicCacheRender(request)) publicPagePolicies.set(request, policy);
}

export async function duringPublicCacheRender<T>(request: Request, render: () => Promise<T>): Promise<T> {
  activePublicRenders.set(request, (activePublicRenders.get(request) ?? 0) + 1);
  try {
    return await render();
  } finally {
    const depth = activePublicRenders.get(request) ?? 1;
    if (depth <= 1) {
      activePublicRenders.delete(request);
      publicPagePolicies.delete(request);
    } else activePublicRenders.set(request, depth - 1);
  }
}

export function assertPublicCacheReadAllowed(request: Request, read: string): void {
  if (isPublicCacheRender(request)) {
    recordPublicPageFailure(request, 500);
    throw new PublicCacheReadError(read);
  }
}

export function isPublicCacheRender(request: Request): boolean {
  return (activePublicRenders.get(request) ?? 0) > 0;
}

/** A caught read violation or router fallback cannot become public successful HTML. */
export function recordPublicPageFailure(request: Request, status: number): void {
  if (!isPublicCacheRender(request)) return;
  publicPageFailures.set(request, status);
  dehydratedPageData.delete(request);
}

export function recordDehydratedPageData(request: Request, data: unknown): void {
  if (isPublicCacheRender(request) && !publicPageFailures.has(request)) dehydratedPageData.set(request, data);
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
    try {
      if (!isPublicPageGetRequest(request)) return privateNoStore(await options.render());
      const eligible = isPageCacheRequest(request);
      // No owner-native fence currently covers every rendered dependency. The ordinary public
      // renderer must run exactly once, even with a warm body or a matching client validator.
      const response = await options.render();
      const failureStatus = publicPageFailures.get(request);
      if (failureStatus !== undefined)
        return privateNoStore(response, failureStatus === 403 || response.status === 200 ? failureStatus : undefined);
      if (privatePageReads.has(request) || !eligible) return privateNoStore(response);
      if (isSubjectFailure(request, response)) return privateNoStore(response);
      if (isCollectionPage(request) && (response.status !== 200 || publicPagePolicies.get(request) !== 'public'))
        return privateNoStore(response);
      if (!isPublicCacheableResponse(response)) return privateNoStore(response);

      const normalized = await rewriteNonce(response, cachedNoncePlaceholder);
      const html = await normalized.text();
      // Streamed rendering can record a restrictive read or a caught failure while draining HTML.
      const completedFailure = publicPageFailures.get(request);
      if (
        completedFailure !== undefined ||
        privatePageReads.has(request) ||
        (isCollectionPage(request) && publicPagePolicies.get(request) !== 'public')
      ) {
        const current = await rewriteNonce(
          new Response(html, normalized),
          (options.freshNonce ?? (() => requestNonce(request) ?? createNonce(request)))(),
        );
        return privateNoStore(
          current,
          completedFailure === 403 || response.status === 200 ? completedFailure : undefined,
        );
      }
      // Cover the complete current HTML as well as loader/query data. A title-only validator
      // cannot establish that a withdrawn document, relation or image is still rendered.
      const etag = await createPageEtag(request.url, options.buildId, {
        data: options.dehydratedData(),
        status: normalized.status,
        html,
      });
      const key = pageCacheKey(request);
      let cached: Response | undefined;
      if (options.cache) {
        try {
          cached = await options.cache.match(key);
        } catch {
          // A Cache API outage leaves the current rendered response available.
        }
      }
      const reusable =
        cached !== undefined &&
        cached.status === normalized.status &&
        isPublicCacheableResponse(cached) &&
        cached.headers.get('cache-control') === storedPageCacheControl &&
        cached.headers.get('etag') === etag;
      // Use current headers even when the complete representation still matches a stored body.
      const headed = withHeaders(new Response(reusable && cached ? cached.body : html, normalized), (headers) => {
        headers.set('cache-control', publicPageCacheControl);
        headers.set('etag', etag);
      });
      if (!reusable && options.cache) {
        try {
          const stored = withHeaders(headed.clone(), (headers) => headers.set('cache-control', storedPageCacheControl));
          await options.cache.put(key, stored);
        } catch {
          // Rendering succeeds even if the shared edge cache cannot store this response.
        }
      }
      if (headed.status === 200 && matchesIfNoneMatch(request.headers.get('if-none-match'), etag))
        return notModified(headed);

      const nonce = (options.freshNonce ?? (() => requestNonce(request) ?? createNonce(request)))();
      return rewriteNonce(headed, nonce);
    } finally {
      privatePageReads.delete(request);
      publicPageFailures.delete(request);
      dehydratedPageData.delete(request);
    }
  });
}

export function pageCacheKey(request: Request): Request {
  return new Request(request.url, { method: 'GET' });
}

export function isPageCacheRequest(request: Request): boolean {
  return (
    isPublicPageGetRequest(request) &&
    !request.headers.has('cookie') &&
    !request.headers.has('authorization') &&
    !(
      isCollectionPage(request) &&
      [...new URL(request.url).searchParams].some(
        ([key, value]) => Boolean(value) && (key === 'cursor' || key === 'type' || /^[frl]\./.test(key)),
      )
    )
  );
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
  const directives = (response.headers.get('cache-control') ?? '')
    .split(',')
    .map((directive) => directive.trim().toLowerCase());
  const vary = (response.headers.get('vary') ?? '').split(',').map((field) => field.trim().toLowerCase());
  return (
    (response.status === 200 || response.status === 404) &&
    response.headers.get('content-type')?.toLowerCase().includes('text/html') === true &&
    !response.headers.has('set-cookie') &&
    !directives.some((directive) => /^(?:private|no-store|no-cache)(?:\s*=|$)/u.test(directive)) &&
    !vary.includes('*')
  );
}

export function privateServerFunctionResponse(response: Response): Response {
  return privateNoStore(response);
}

function privateNoStore(response: Response, status = response.status): Response {
  const headers = new Headers(response.headers);
  headers.set('cache-control', 'private, no-store');
  headers.delete('etag');
  if (headers.get('content-type')?.toLowerCase().includes('text/html')) headers.set('x-robots-tag', 'noindex');
  return new Response(response.body, {
    status,
    ...(status === response.status ? { statusText: response.statusText } : {}),
    headers,
  });
}

function isCollectionPage(request: Request): boolean {
  return /(?:^|\/)collections\/[^/]+\/?$/u.test(new URL(request.url).pathname);
}

function isSubjectFailure(request: Request, response: Response): boolean {
  return response.status !== 200 && /\/(?:subjects\/|@)/u.test(new URL(request.url).pathname);
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
  for (const name of ['etag', 'cache-control', 'vary', 'content-location', 'expires']) {
    const value = response.headers.get(name);
    if (value) headers.set(name, value);
  }
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
