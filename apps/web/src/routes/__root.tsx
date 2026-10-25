import { createRootRoute, HeadContent, Outlet, Scripts, useRouterState } from '@tanstack/react-router';
import { createIsomorphicFn, createServerFn } from '@tanstack/react-start';
import { getRequest, getRequestHeader, setResponseStatus } from '@tanstack/react-start/server';
import { useLayoutEffect } from 'react';
import { env } from 'cloudflare:workers';
import type { SessionEnv } from '../session/client.ts';
import { readSessionState } from '../session/state.ts';
import { m } from '../paraglide/messages.js';
import { getLocale, locales } from '../paraglide/runtime.js';
import { AppShell, NotFoundPage } from '../shell/shell';
import { ClosedErrorPage, ClosedPage } from '../shell/closed.tsx';
import { isPlatformClosedError } from '../kernel/platform-closed.ts';
import '../styles.css';

const readPreferences = createServerFn({ method: 'GET' }).handler(async () => {
  const cookie = getRequestHeader('cookie') ?? '';
  const theme = /(?:^|;\s*)rezics_theme=(system|light|dark)(?:;|$)/.exec(cookie)?.[1] ?? 'system';
  const host = getRequestHeader('host') ?? 'localhost';
  const protocol = getRequestHeader('x-forwarded-proto') ?? 'http';
  const session = await readSessionState(getRequest(), env as Partial<SessionEnv>);
  return {
    theme,
    origin: `${protocol}://${host}`,
    collapsed: /(?:^|;\s*)rezics_nav=collapsed(?:;|$)/.test(cookie),
    session: session.state,
    csrfToken: session.csrfToken,
  };
});
const setClosedResponseStatus = createIsomorphicFn()
  .server(() => setResponseStatus(403, 'Forbidden'))
  .client(() => undefined);
export const Route = createRootRoute({
  loader: () => readPreferences(),
  head: ({ loaderData }) => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: m.home_heading() },
      ...(loaderData?.csrfToken ? [{ name: 'csrf-token', content: loaderData.csrfToken }] : []),
    ],
    links: [
      { rel: 'icon', href: '/favicon.svg', type: 'image/svg+xml' },
      ...locales.map((locale) => ({
        rel: 'alternate',
        hrefLang: locale,
        href: `${loaderData?.origin ?? 'http://localhost'}/${locale}`,
      })),
      { rel: 'alternate', hrefLang: 'x-default', href: `${loaderData?.origin ?? 'http://localhost'}/` },
    ],
  }),
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
