import { createRootRoute, HeadContent, Outlet, Scripts } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { useLayoutEffect } from 'react';
import { getLocale } from '../paraglide/runtime.js';
import { AuthShell } from '../frame';
import { RouteFailureError, RouteMissing, RouteRecoveryProvider } from '../route-failure-view';
import '../styles.css';

export const Route = createRootRoute({
  component: () => <Outlet />,
  shellComponent: Root,
  errorComponent: RouteFailureError,
  notFoundComponent: RouteMissing,
});

function Root({ children }: { children: ReactNode }) {
  useLayoutEffect(() => {
    document.documentElement.dataset.hydrated = '';
  }, []);
  return (
    <html lang={getLocale()}>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="icon" href={import.meta.env.BASE_URL + 'rezics-mark.svg'} type="image/svg+xml" />
        <HeadContent />
      </head>
      <body>
        <AuthShell>
          <RouteRecoveryProvider>{children}</RouteRecoveryProvider>
        </AuthShell>
        <Scripts />
      </body>
    </html>
  );
}
