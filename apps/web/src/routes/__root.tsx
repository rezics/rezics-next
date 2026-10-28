import { createRootRouteWithContext, HeadContent, Outlet, Scripts, useRouterState } from '@tanstack/react-router';
import type { QueryClient } from '@tanstack/react-query';
import { createIsomorphicFn } from '@tanstack/react-start';
import { setResponseStatus } from '@tanstack/react-start/server';
import { useEffect, useLayoutEffect, useRef } from 'react';
import { useRouter } from '@tanstack/react-router';
import { env } from 'cloudflare:workers';
import { PreferencesScript } from '../shell/preferences-script';
import { getLocale } from '../paraglide/runtime.js';
import { AppShell, NotFoundPage } from '../shell/shell';
import { ClosedErrorPage, ClosedPage, closedPageHead } from '../shell/closed.tsx';
import { isPlatformClosedError } from '../kernel/platform-closed.ts';
import { anonymousReadMode, type ReadCredentialMode } from '../kernel/credential.ts';
import { useSession } from '../session/query.ts';
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
export const Route = createRootRouteWithContext<{
  queryClient: QueryClient;
  credentialMode: ReadCredentialMode;
}>()({
  head: ({ matches }) => {
    const locale = getLocale();
    const last = matches.at(-1);
    const data = last?.loaderData as { paths?: PagePaths } | undefined;
    const path = last?.pathname ?? '/';
    const origin = publicOrigin();
    const context = { origin, locale, path, ...(data?.paths ? { paths: data.paths } : {}) };
    const closed = matches.some((match) => match.status === 'error' && isPlatformClosedError(match.error));
    const missing = matches.length === 1 || matches.some((match) => match.status === 'notFound');
    const head = closed ? closedPageHead(context) : pageHead(missing ? { robots: 'noindex' } : {}, context);
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
  const router = useRouter();
  const { state: session } = useSession();
  const platformClosed = useRouterState({
    select: (state) => state.matches.some((match) => match.status === 'error' && isPlatformClosedError(match.error)),
  });
  const rereadPage = useRouterState({
    select: (state) =>
      state.matches.length === 1 ||
      state.matches.some((entry) => {
        const match = entry as unknown as {
          status: string;
          error?: unknown;
          staticData?: { sessionReread?: boolean };
        };
        return (
          match.staticData?.sessionReread === true ||
          match.status === 'notFound' ||
          (match.status === 'error' && isPlatformClosedError(match.error))
        );
      }),
  });
  const credentialMode = useRef<ReadCredentialMode>(anonymousReadMode);
  if (platformClosed) setClosedResponseStatus();
  useEffect(() => {
    if (session !== 'signed-in' || !rereadPage || credentialMode.current === 'session') return;
    credentialMode.current = 'session';
    router.update({ context: { ...router.options.context, credentialMode: 'session' } });
    void router.invalidate();
  }, [router, session, rereadPage]);
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
