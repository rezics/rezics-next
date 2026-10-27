import { createRootRouteWithContext, HeadContent, Outlet, Scripts, useRouterState } from '@tanstack/react-router';
import type { QueryClient } from '@tanstack/react-query';
import { createIsomorphicFn, createServerFn } from '@tanstack/react-start';
import { getRequest, getRequestHeader, setResponseStatus } from '@tanstack/react-start/server';
import { useLayoutEffect } from 'react';
import { env } from 'cloudflare:workers';
import type { SessionEnv } from '../session/client.ts';
import { readSessionState } from '../session/state.ts';
import { getLocale } from '../paraglide/runtime.js';
import { AppShell, NotFoundPage } from '../shell/shell';
import { ClosedErrorPage, ClosedPage } from '../shell/closed.tsx';
import { isPlatformClosedError } from '../kernel/platform-closed.ts';
import { pageHead, pageLinks, type PagePaths } from '../shell/head.ts';
import { validatePublicOrigin } from '../shell/origin.ts';
import '../styles.css';

const readPreferences = createServerFn({ method: 'GET' }).handler(async () => {
  const cookie = getRequestHeader('cookie') ?? '';
  const theme = /(?:^|;\s*)rezics_theme=(system|light|dark)(?:;|$)/.exec(cookie)?.[1] ?? 'system';
  const session = await readSessionState(getRequest(), env as Partial<SessionEnv>);
  return {
    theme,
    collapsed: /(?:^|;\s*)rezics_nav=collapsed(?:;|$)/.test(cookie),
    session: session.state,
    csrfToken: session.csrfToken,
  };
});
const setClosedResponseStatus = createIsomorphicFn()
  .server(() => setResponseStatus(403, 'Forbidden'))
  .client(() => undefined);
const publicOrigin = createIsomorphicFn()
  .server(() => validatePublicOrigin((env as typeof env & { PUBLIC_ORIGIN?: string }).PUBLIC_ORIGIN))
  .client(() =>
    validatePublicOrigin(new URL(document.querySelector<HTMLLinkElement>('link[rel="canonical"]')!.href).origin),
  );
export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  loader: () => readPreferences(),
  head: ({ loaderData, matches }) => {
    const locale = getLocale();
    const last = matches.at(-1);
    const data = last?.loaderData as { paths?: PagePaths } | undefined;
    const path = last?.pathname ?? '/';
    const origin = publicOrigin();
    const context = { origin, locale, path, ...(data?.paths ? { paths: data.paths } : {}) };
    const head = pageHead({}, context);
    return {
      meta: [
        { charSet: 'utf-8' },
        { name: 'viewport', content: 'width=device-width, initial-scale=1' },
        ...head.meta,
        ...(loaderData?.csrfToken ? [{ name: 'csrf-token', content: loaderData.csrfToken }] : []),
      ],
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
  const { theme, collapsed, session, csrfToken } = Route.useLoaderData();
  const platformClosed = useRouterState({
    select: (state) => state.matches.some((match) => match.status === 'error' && isPlatformClosedError(match.error)),
  });
  if (platformClosed) setClosedResponseStatus();
  useLayoutEffect(() => {
    document.documentElement.dataset.hydrated = '';
  }, []);
  return (
    <html lang={getLocale()} className={theme === 'system' ? undefined : theme}>
      <head>
        <HeadContent />
      </head>
      <body>
        <AppShell theme={theme} collapsed={collapsed} session={session} csrfToken={csrfToken}>
          {platformClosed ? <ClosedPage /> : <Outlet />}
        </AppShell>
        <Scripts />
      </body>
    </html>
  );
}
