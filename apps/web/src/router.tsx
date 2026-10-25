import { createIsomorphicFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import { requestNonce } from './security/nonce.ts';
import { createRouter } from '@tanstack/react-router';
import { routeTree } from './routeTree.gen';
import { deLocalizeUrl, localizeUrl } from './paraglide/runtime.js';
const nonce = createIsomorphicFn()
  .server(() => requestNonce(getRequest()))
  .client(() => document.querySelector<HTMLMetaElement>('meta[property="csp-nonce"]')?.content);

export function getRouter() {
  const cspNonce = nonce();
  return createRouter({
    routeTree,
    ssr: cspNonce ? { nonce: cspNonce } : {},
    rewrite: { input: ({ url }) => deLocalizeUrl(url).href, output: ({ url }) => localizeUrl(url).href },
  });
}
declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
