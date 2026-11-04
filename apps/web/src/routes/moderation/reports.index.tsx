import { createFileRoute, useLocation, useRouter } from '@tanstack/react-router';
import { useMemo } from 'react';
import { prepareExposure } from '../../kernel/exposure';
import { ReporterHistoryCurrent, ReporterHistoryPage } from '../../moderation/reporter-history/view';
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
  gcTime: 0,
  pendingComponent: () => <ReporterHistoryPage result={{ state: 'loading' }} query={{}} />,
  head: ({ match }) =>
    pageHead({ title: m.reporter_history_heading(), robots: 'noindex, nofollow' }, pageHeadContext(match.pathname)),
  component: ReporterHistoryRoute,
  errorComponent: () => <ReporterHistoryPage result={{ state: 'unavailable' }} query={{}} />,
});

function ReporterHistoryRoute() {
  const initial = Route.useLoaderData();
  const router = useRouter();
  const location = useLocation();
  const navigationKey = location.state.__TSR_key ?? location.href;
  const navigation = useMemo(
    () => ({
      isCurrent: () =>
        (router.state.location.state.__TSR_key ?? router.state.location.href) === initial.navigationKey,
      subscribe: (retire: () => void) => {
        const leave = router.subscribe('onBeforeNavigate', ({ toLocation }) => {
          if ((toLocation.state.__TSR_key ?? toLocation.href) !== initial.navigationKey) retire();
        });
        const reload = router.subscribe('onBeforeLoad', retire);
        return () => {
          leave();
          reload();
        };
      },
    }),
    [router, initial.navigationKey, initial.generation],
  );
  return <ReporterHistoryCurrent key={`${initial.generation}:${navigationKey}`} initial={initial} navigation={navigation} />;
}
