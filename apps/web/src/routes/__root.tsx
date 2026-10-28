import { createRootRouteWithContext, HeadContent, Outlet, Scripts, useRouterState } from '@tanstack/react-router';
import type { QueryClient } from '@tanstack/react-query';
import { createIsomorphicFn } from '@tanstack/react-start';
import { setResponseStatus } from '@tanstack/react-start/server';
import { useLayoutEffect } from 'react';
import { env } from 'cloudflare:workers';
import { PreferencesScript } from '../shell/preferences-script';
import { getLocale } from '../paraglide/runtime.js';
import { AppShell, NotFoundPage } from '../shell/shell';
import { ClosedErrorPage, ClosedPage } from '../shell/closed.tsx';
import { isPlatformClosedError } from '../kernel/platform-closed.ts';
import { pageHead, pageLinks, type PagePaths } from '../shell/head.ts';
import { validatePublicOrigin } from '../shell/origin.ts';
import '../styles.css';

const setClosedResponseStatus = createIsomorphicFn()
  .server(() => setResponseStatus(403, 'Forbidden'))
  .client(() => undefined);
const publicOrigin = createIsomorphicFn()
  .server(() => validatePublicOrigin((env as typeof env & { PUBLIC_ORIGIN?: string }).PUBLIC_ORIGIN))
  .client(() =>
    validatePublicOrigin(new URL(document.querySelector<HTMLLinkElement>('link[rel="canonical"]')!.href).origin),
  );
export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: ({ matches }) => {
    const locale = getLocale();
    const last = matches.at(-1);
    const data = last?.loaderData as { paths?: PagePaths } | undefined;
    const path = last?.pathname ?? '/';
    const origin = publicOrigin();
    const context = { origin, locale, path, ...(data?.paths ? { paths: data.paths } : {}) };
    const head = pageHead({}, context);
    return {
      meta: [{ charSet: 'utf-8' }, { name: 'viewport', content: 'width=device-width, initial-scale=1' }, ...head.meta],
      links: [
        { rel: 'icon', href: '/favicon.svg', type: 'image/svg+xml' },
        ...pageLinks(origin, locale, path, data?.paths),
      ],
    };
  },
  component: Root,
  notFoundComponent: NotFoundPage,
  errorComponent: ClosedErrorPage,
});
function Root() {
  const platformClosed = useRouterState({
    select: (state) => state.matches.some((match) => match.status === 'error' && isPlatformClosedError(match.error)),
  });
  if (platformClosed) setClosedResponseStatus();
  useLayoutEffect(() => {
    document.documentElement.dataset.hydrated = '';
  }, []);
  return (
    <html lang={getLocale()} suppressHydrationWarning>
      <head>
        <PreferencesScript />
        <HeadContent />
      </head>
      <body>
        <AppShell>{platformClosed ? <ClosedPage /> : <Outlet />}</AppShell>
        <Scripts />
      </body>
    </html>
  );
}
