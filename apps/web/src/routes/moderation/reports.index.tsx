import { createFileRoute, useLocation, useRouter } from '@tanstack/react-router';
import { useLayoutEffect, useMemo } from 'react';
import { browserObservation } from '../../session/observation';
import { reporterHistoryFocusFor } from '../../moderation/reporter-history/focus';
import { prepareExposure } from '../../kernel/exposure';
import { ReporterHistoryCurrent, ReporterHistoryPage } from '../../moderation/reporter-history/view';
import { reporterHistoryStatusHref } from '../../moderation/reporter-history/navigation';
import { reporterHistoryQuery } from '../../moderation/reporter-history/model';
import { prepareReporterHistoryVisit } from '../../moderation/reporter-history/journey';
import { readReporterHistory } from '../../moderation/reporter-history/server';
import { m } from '../../paraglide/messages.js';
import { getLocale } from '../../paraglide/runtime.js';
import { requireSignedIn } from '../../session/guard';
import { pageHead } from '../../shell/head';
import { pageHeadContext } from '../../shell/head-context';

export const Route = createFileRoute('/moderation/reports/')({
  beforeLoad: async (args) => {
    await requireSignedIn(args);
    await prepareExposure(args.context.queryClient);
  },
  validateSearch: reporterHistoryQuery,
  loaderDeps: ({ search }) => ({
    ...(search.cursor === undefined ? {} : { cursor: search.cursor }),
    ...(search.reportId === undefined ? {} : { reportId: search.reportId }),
  }),
  loader: async ({ deps, context, abortController, location }) => {
    const visit = await prepareReporterHistoryVisit(
      context.queryClient,
      deps,
      getLocale(),
      (data) => readReporterHistory({ data }),
      abortController.signal,
    );
    return Object.assign(visit, { navigationKey: location.state.__TSR_key ?? location.href });
  },
  pendingMs: 0,
  pendingMinMs: 0,
  staleTime: 0,
  shouldReload: true,
  gcTime: 0,
  pendingComponent: () => <ReporterHistoryRecovery state="loading" />,
  head: ({ match }) =>
    pageHead({ title: m.reporter_history_heading(), robots: 'noindex, nofollow' }, pageHeadContext(match.pathname)),
  component: ReporterHistoryRoute,
  errorComponent: () => <ReporterHistoryRecovery state="unavailable" />,
});

function ReporterHistoryRoute() {
  const initial = Route.useLoaderData();
  const router = useRouter();
  const location = useLocation();
  const focus = reporterHistoryFocusFor(router);
  const navigationKey = location.state.__TSR_key ?? location.href;
  const navigation = useMemo(
    () => ({
      request: async (query: Parameters<typeof reporterHistoryQuery>[0]) => {
        const operands = reporterHistoryQuery(query);
        focus.request(operands);
        if (operands.cursor === initial.query.cursor && operands.reportId === initial.query.reportId) {
          await router.invalidate({ sync: true });
        } else {
          await router.navigate({ to: '/moderation/reports', search: operands, resetScroll: false });
        }
      },
      openStatus: async (reportId: string, cursor?: string) => {
        focus.requestStatus(reportId);
        await router.navigate({ href: reporterHistoryStatusHref(reportId, cursor) });
      },
      isCurrent: () => (router.state.location.state.__TSR_key ?? router.state.location.href) === initial.navigationKey,
      subscribe: (retire: () => void) => {
        const leave = router.subscribe('onBeforeNavigate', ({ toLocation }) => {
          try {
            const statusId = /^\/moderation\/reports\/([^/]+)$/.exec(toLocation.pathname)?.[1];
            if (statusId) focus.navigatingStatus(statusId);
            else
              focus.navigating(
                toLocation.pathname.replace(/\/$/, '') === '/moderation/reports'
                  ? reporterHistoryQuery(toLocation.search)
                  : null,
              );
          } catch {
            focus.cancel();
          }
          if ((toLocation.state.__TSR_key ?? toLocation.href) !== initial.navigationKey) retire();
        });
        const reload = router.subscribe('onBeforeLoad', retire);
        return () => {
          leave();
          reload();
        };
      },
    }),
    [router, initial.navigationKey, initial.generation, focus],
  );
  return (
    <ReporterHistoryCurrent
      key={`${initial.generation}:${navigationKey}`}
      initial={initial}
      navigation={navigation}
      focus={focus}
    />
  );
}

function ReporterHistoryRecovery({ state }: { state: 'loading' | 'unavailable' }) {
  const query = Route.useSearch();
  const router = useRouter();
  const { queryClient } = Route.useRouteContext();
  const focus = reporterHistoryFocusFor(router);
  useLayoutEffect(() => {
    // A native back/forward or explicit return has no surviving inventory control.
    // Start watching here so a Tab or focus movement during preparation cancels recovery.
    if (focus.pending() || document.activeElement !== document.body) return;
    const locale = getLocale();
    const browser = browserObservation(queryClient);
    const original = browser.getSnapshot();
    focus.activate(document.body, () => {
      const next = browser.getSnapshot();
      return (
        locale === getLocale() &&
        original.state === 'signed-in' &&
        next.state === 'signed-in' &&
        original.observation === next.observation
      );
    });
    focus.request(query);
  }, [focus, queryClient, query]);
  return <ReporterHistoryPage result={{ state }} query={query} onRetry={() => router.invalidate({ sync: true })} />;
}
