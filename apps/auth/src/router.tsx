import { createRouter } from '@tanstack/react-router';
import { createIsomorphicFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import { requestNonce } from './security/nonce.ts';
import { routeTree } from './routeTree.gen';
import { observeLocaleComponent } from './locale-observation';
import { RouteFailureError } from './route-failure-view';

const nonce = createIsomorphicFn()
  .server(() => requestNonce(getRequest()))
  .client(() => document.querySelector<HTMLMetaElement>('meta[property="csp-nonce"]')?.content);

export function getRouter() {
  const cspNonce = nonce();
  const router = createRouter({
    routeTree,
    defaultErrorComponent: RouteFailureError,
    ssr: cspNonce ? { nonce: cspNonce } : {},
  });
  for (const route of Object.values(router.routesById)) {
    if (route.options.component) route.options.component = observeLocaleComponent(route.options.component);
  }
  return router;
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
