import { createRootRoute, HeadContent, Outlet, Scripts } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { getRequest, getRequestHeader } from '@tanstack/react-start/server';
import { useLayoutEffect } from 'react';
import { env } from 'cloudflare:workers';
import type { SessionEnv } from '../session/client.ts';
import { readSessionState } from '../session/state.ts';
import { m } from '../paraglide/messages.js';
import { getLocale, locales } from '../paraglide/runtime.js';
import { AppShell, ErrorPage, NotFoundPage } from '../shell/shell';
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
    session,
  };
});
export const Route = createRootRoute({
  loader: () => readPreferences(),
  head: ({ loaderData }) => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: m.home_heading() },
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
  errorComponent: ErrorPage,
});
function Root() {
  const { theme, collapsed, session } = Route.useLoaderData();
  useLayoutEffect(() => {
    document.documentElement.dataset.hydrated = '';
  }, []);
  return (
    <html lang={getLocale()} className={theme === 'system' ? undefined : theme}>
      <head>
        <HeadContent />
      </head>
      <body>
        <AppShell theme={theme} collapsed={collapsed} session={session}>
          <Outlet />
        </AppShell>
        <Scripts />
      </body>
    </html>
  );
}
