import {
  createRootRouteWithContext,
  HeadContent,
  isNotFound,
  Outlet,
  Scripts,
  useRouter,
  useRouterState,
} from '@tanstack/react-router';
import type { QueryClient } from '@tanstack/react-query';
import { createIsomorphicFn } from '@tanstack/react-start';
import { getResponseStatus, setResponseHeader, setResponseStatus } from '@tanstack/react-start/server';
import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
import { env } from 'cloudflare:workers';
import { PreferencesScript } from '../shell/preferences-script';
import { getLocale } from '../paraglide/runtime.js';
import { AppShell } from '../shell/app-shell';
import { NotFoundPage } from '../shell/shell';
import { ClosedErrorPage, ClosedPage } from '../shell/closed.tsx';
import { errorPageHead, routeFailure } from '../shell/error-state';
import { isPlatformClosedError } from '../kernel/platform-closed.ts';
import { anonymousReadMode, type ReadCredentialMode } from '../kernel/credential.ts';
import { useSession } from '../session/query.ts';
import { pageHead, pageLinks, type PagePaths } from '../shell/head.ts';
import { validatePublicOrigin } from '../shell/origin.ts';
import '../styles.css';
import { prepareExposure } from '../kernel/exposure';
import { isSignedInPath } from '../session/guard';
import { createNavigation } from '../shell/navigation';
import { m } from '../paraglide/messages.js';
import { Tags, ChartNoAxesCombined, FileText } from 'lucide-react';
import { subjectPurchaseRegions } from '../checkout/subject-purchase';
import { contextsNavigation } from '../features/contexts/navigation';
import { myLogsNavigation } from '../library/my-logs';
import { threadsNavigation } from '../threads/navigation';
import { zonesNavigation } from '../features/zones/manage/navigation';
import { catalogueNavigation } from '../features/catalogue/navigation';
import { importReviewNavigation } from '../features/import-review/navigation';
import { communityNavigation } from '../community/navigation';
import { libraryNavigation } from '../library/navigation';

export const commerceNavigation = createNavigation([
  ...contextsNavigation,
  ...myLogsNavigation,
  ...threadsNavigation,
  ...zonesNavigation,
  ...catalogueNavigation,
  ...importReviewNavigation,
  ...communityNavigation,
  ...libraryNavigation,
  {
    id: 'commerce.creator-offers',
    kind: 'navigation',
    group: 'personal',
    order: 15,
    label: ({ locale }) => m.creator_offers_heading({}, { locale }),
    href: '/creator/offers',
    match: 'prefix',
    signedIn: true,
    operation: 'offer.list',
    icon: Tags,
  },
  {
    id: 'commerce.creator-sales',
    kind: 'navigation',
    group: 'personal',
    order: 16,
    label: ({ locale }) => m.creator_sales_heading({}, { locale }),
    href: '/creator/sales',
    match: 'prefix',
    signedIn: true,
    operation: 'commerce_sale.list',
    icon: ChartNoAxesCombined,
  },
  {
    id: 'commerce.creator-statements',
    kind: 'navigation',
    group: 'personal',
    order: 17,
    label: ({ locale }) => m.statements_heading({}, { locale }),
    href: '/creator/statements',
    match: 'prefix',
    signedIn: true,
    operation: 'payout_statement.list',
    icon: FileText,
  },
]);

const preserveErrorResponse = createIsomorphicFn()
  .server((matches: Parameters<typeof routeFailure>[0]) => {
    const failure = routeFailure(matches, getResponseStatus());
    if (!failure) return;
    setResponseStatus(failure.status);
    setResponseHeader('cache-control', 'private, no-store');
    setResponseHeader('x-robots-tag', 'noindex');
    if (failure.retryAfter) setResponseHeader('retry-after', failure.retryAfter);
  })
  .client(() => undefined);
const publicOrigin = createIsomorphicFn()
  .server(() => validatePublicOrigin((env as typeof env & { PUBLIC_ORIGIN?: string }).PUBLIC_ORIGIN))
  .client(() =>
    validatePublicOrigin(
      new URL(document.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.href ?? window.location.origin).origin,
    ),
  );
export const Route = createRootRouteWithContext<{
  queryClient: QueryClient;
  credentialMode: ReadCredentialMode;
}>()({
  beforeLoad: ({ context, location }) =>
    isSignedInPath(location.pathname) ? undefined : prepareExposure(context.queryClient),
  head: ({ matches }) => {
    const locale = getLocale();
    const last = matches.at(-1);
    const data = last?.loaderData as { paths?: PagePaths } | undefined;
    const path = last?.pathname ?? '/';
    const origin = publicOrigin();
    const failure = routeFailure(matches);
    preserveErrorResponse(matches);
    const missing = failure?.missing;
    const hiddenAgentHandle = missing && /^\/(?:[^/]+\/)?@[^/]+(?:\/[^/]+)?$/.test(path);
    const safePath = hiddenAgentHandle ? `/${locale}` : path;
    const context = {
      origin,
      locale,
      path: safePath,
      ...(data?.paths && !hiddenAgentHandle ? { paths: data.paths } : {}),
    };
    const head = failure ? errorPageHead(context) : pageHead({}, context);
    return {
      meta: [{ charSet: 'utf-8' }, { name: 'viewport', content: 'width=device-width, initial-scale=1' }, ...head.meta],
      links: [
        { rel: 'icon', href: '/favicon.svg', type: 'image/svg+xml' },
        ...pageLinks(origin, locale, safePath, failure || hiddenAgentHandle ? undefined : data?.paths),
      ],
    };
  },
  shellComponent: Root,
  component: Outlet,
  notFoundComponent: NotFoundPage,
  errorComponent: ClosedErrorPage,
});
function Root({ children }: { children: ReactNode }) {
  const router = useRouter();
  const nonce = router.options.ssr?.nonce;
  const { state: session } = useSession();
  const platformClosed = useRouterState({
    select: (state) => state.matches.some((match) => match.status === 'error' && isPlatformClosedError(match.error)),
  });
  const rereadPage = useRouterState({
    select: (state) =>
      (state.matches.length === 1 && state.matches[0]?.status !== 'error') ||
      state.matches.some((entry) => {
        const match = entry as unknown as {
          status: string;
          error?: unknown;
          _notFound?: boolean;
          routeId?: string;
          staticData?: { sessionReread?: boolean };
        };
        const route = match.routeId
          ? (
              router.routesById as unknown as Record<string, { options?: { staticData?: { sessionReread?: boolean } } }>
            )[match.routeId]
          : undefined;
        return (
          match.staticData?.sessionReread === true ||
          route?.options?.staticData?.sessionReread === true ||
          match._notFound === true ||
          match.status === 'notFound' ||
          isNotFound(match.error) ||
          (match.status === 'error' && isPlatformClosedError(match.error))
        );
      }),
  });
  const credentialMode = useRef<ReadCredentialMode>(anonymousReadMode);
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
        {nonce ? <meta property="csp-nonce" content={nonce} /> : null}
        <PreferencesScript />
        <HeadContent />
      </head>
      <body>
        <AppShell navigation={commerceNavigation} subjectPurchase={subjectPurchaseRegions}>
          {platformClosed ? <ClosedPage /> : children}
        </AppShell>
        <Scripts />
      </body>
    </html>
  );
}
