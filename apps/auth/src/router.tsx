import { createRouter } from '@tanstack/react-router';
import { createIsomorphicFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import { requestNonce } from './security/nonce.ts';
import { routeTree } from './routeTree.gen';

const nonce = createIsomorphicFn()
  .server(() => requestNonce(getRequest()))
  .client(() => document.querySelector<HTMLMetaElement>('meta[property="csp-nonce"]')?.content);

export function getRouter() {
  const cspNonce = nonce();
  return createRouter({ routeTree, ssr: cspNonce ? { nonce: cspNonce } : {} });
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
