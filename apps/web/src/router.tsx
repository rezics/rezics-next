import { createIsomorphicFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import { requestNonce } from './security/nonce.ts';
import { createRouter } from '@tanstack/react-router';
import { QueryClient } from '@tanstack/react-query';
import { anonymousReadMode } from './kernel/credential';
import { setupRouterSsrQueryIntegration } from '@tanstack/react-router-ssr-query';
import { ClosedErrorPage } from './shell/closed';
import { NotFoundPage } from './shell/shell';
import { PendingPage } from './shell/pending';
import { routeTree } from './routeTree.gen';
import { deLocalizeUrl, localizeUrl } from './paraglide/runtime.js';

type RouteNode = {
  options?: { id?: string; path?: string; staticData?: { publicCache?: boolean } };
  children?: Record<string, RouteNode>;
};

type PublicCachePathMatch = { marked: boolean; specificity: number[]; depth: number };

function routePattern(path: string): RegExp {
  const segments = path.split('/').map((segment) => {
    if (/^@\{\$[^}]+\}_?$/.test(segment)) return '@[^/]+';
    if (segment.startsWith('$')) return '[^/]+';
    if (segment === '*') return '.+';
    return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  });
  return new RegExp(`^${segments.join('/')}/?$`);
}

function routeSpecificity(path: string): number[] {
  return path
    .split('/')
    .filter(Boolean)
    .map((segment) => {
      if (segment === '*') return 0;
      if (segment.startsWith('$') || /^@\{\$[^}]+\}_?$/.test(segment)) return 1;
      return 2;
    });
}

function moreSpecific(left: PublicCachePathMatch, right: PublicCachePathMatch): boolean {
  const length = Math.min(left.specificity.length, right.specificity.length);
  for (let index = 0; index < length; index += 1) {
    if (left.specificity[index] !== right.specificity[index])
      return left.specificity[index]! > right.specificity[index]!;
  }
  return left.specificity.length > right.specificity.length || left.depth > right.depth;
}

function hasPublicCachePath(
  route: RouteNode,
  pathname: string,
  parentPath = '/',
  inherited = false,
  depth = 0,
): PublicCachePathMatch | undefined {
  const routePath = route.options?.path ?? route.options?.id ?? '';
  const fullPath = routePath.startsWith('/') ? routePath : `${parentPath.replace(/\/$/, '')}/${routePath}`;
  const marked = inherited || route.options?.staticData?.publicCache === true;
  const matches: PublicCachePathMatch[] = [];
  if (routePath && routePattern(fullPath || '/').test(pathname))
    matches.push({ marked, specificity: routeSpecificity(fullPath), depth });
  for (const child of Object.values(route.children ?? {})) {
    const match = hasPublicCachePath(child, pathname, fullPath, marked, depth + 1);
    if (match) matches.push(match);
  }
  return matches.reduce<PublicCachePathMatch | undefined>(
    (best, match) => (best === undefined || moreSpecific(match, best) ? match : best),
    undefined,
  );
}

export function isPublicCacheRequest(request: Request): boolean {
  const publicUrl = deLocalizeUrl(new URL(request.url));
  const root = routeTree as unknown as RouteNode;
  if (root.options?.staticData?.publicCache === true) return true;
  const matches = Object.values(root.children ?? {}).flatMap((route) => {
    const match = hasPublicCachePath(route, publicUrl.pathname);
    return match ? [match] : [];
  });
  const best = matches.reduce<PublicCachePathMatch | undefined>(
    (current, match) => (current === undefined || moreSpecific(match, current) ? match : current),
    undefined,
  );
  return best?.marked === true;
}
const nonce = createIsomorphicFn()
  .server(() => requestNonce(getRequest()))
  .client(() => document.querySelector<HTMLMetaElement>('meta[property="csp-nonce"]')?.content);

function parseSearch(searchString: string): Record<string, unknown> {
  const search = new URLSearchParams(searchString);
  const parsed: Record<string, unknown> = Object.create(null);
  for (const [key, value] of search) {
    if (!Object.hasOwn(parsed, key)) parsed[key] = value;
    else if (Array.isArray(parsed[key])) (parsed[key] as string[]).push(value);
    else parsed[key] = [parsed[key] as string, value];
  }
  return parsed;
}

function stringifySearch(search: Record<string, unknown>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(search)) {
    if (typeof value === 'string') params.append(key, value);
    else if (Array.isArray(value)) {
      for (const item of value) if (typeof item === 'string') params.append(key, item);
    }
  }
  const query = params.toString();
  return query ? `?${query}` : '';
}

export function getRouter() {
  const cspNonce = nonce();
  const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 60_000 } } });
  const router = createRouter({
    context: { queryClient, credentialMode: anonymousReadMode },
    defaultPreload: 'intent',
    defaultPreloadStaleTime: 0,
    defaultPendingComponent: PendingPage,
    defaultErrorComponent: ClosedErrorPage,
    defaultNotFoundComponent: NotFoundPage,
    routeTree,
    parseSearch,
    stringifySearch,
    ssr: cspNonce ? { nonce: cspNonce } : {},
    rewrite: { input: ({ url }) => deLocalizeUrl(url).href, output: ({ url }) => localizeUrl(url).href },
  });
  setupRouterSsrQueryIntegration({ router, queryClient });
  return router;
}
declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
