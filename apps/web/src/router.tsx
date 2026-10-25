import { createIsomorphicFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import { requestNonce } from './security/nonce.ts';
import { createRouter } from '@tanstack/react-router';
import { routeTree } from './routeTree.gen';
import { deLocalizeUrl, localizeUrl } from './paraglide/runtime.js';
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
  return createRouter({
    routeTree,
    parseSearch,
    stringifySearch,
    ssr: cspNonce ? { nonce: cspNonce } : {},
    rewrite: { input: ({ url }) => deLocalizeUrl(url).href, output: ({ url }) => localizeUrl(url).href },
  });
}
declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
