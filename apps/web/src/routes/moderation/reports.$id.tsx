import { useMemo } from 'react';
import { createFileRoute, useRouter } from '@tanstack/react-router';
import { readReporterStatus } from '../../moderation/reporter-status-read';
import { prepareReporterStatusRead } from '../../moderation/reporter-status-read-model';
import { reporterHistoryFocusFor } from '../../moderation/reporter-history/focus';
import { reporterHistoryQuery } from '../../moderation/reporter-history/model';
import { reporterHistoryReturnHref, reporterHistoryStatusSearch } from '../../moderation/reporter-history/navigation';
import { ReporterStatusCurrent, ReporterStatusPage } from '../../moderation/reporter-status-view';
import { m } from '../../paraglide/messages.js';
import { localizeHref } from '../../paraglide/runtime.js';
import { requireSignedIn } from '../../session/guard';
import { pageHead } from '../../shell/head';
import { pageHeadContext } from '../../shell/head-context';

export const Route = createFileRoute('/moderation/reports/$id')({
  beforeLoad: requireSignedIn,
  validateSearch: reporterHistoryStatusSearch,
  shouldReload: true,
  loader: async ({ params, context, abortController, location }) => {
    const read = await prepareReporterStatusRead(
      context.queryClient,
      params.id,
      (data) => readReporterStatus({ data }),
      abortController.signal,
    );
    return Object.assign(read, { navigationKey: location.state.__TSR_key ?? location.href });
  },
  pendingMs: 0,
  pendingMinMs: 0,
  staleTime: 0,
  gcTime: 0,
  pendingComponent: () => <ReporterStatusRecovery state="loading" />,
  head: ({ match }) =>
    pageHead({ title: m.reporter_status_heading(), robots: 'noindex, nofollow' }, pageHeadContext(match.pathname)),
  component: ReporterStatusRoute,
  errorComponent: () => <ReporterStatusRecovery state="concealed" />,
});

function ReporterStatusRoute() {
  const initial = Route.useLoaderData();
  const search = Route.useSearch();
  const router = useRouter();
  const focus = reporterHistoryFocusFor(router);
  const navigation = useMemo(
    () => ({
      isCurrent: () => (router.state.location.state.__TSR_key ?? router.state.location.href) === initial.navigationKey,
      subscribe: (retire: () => void) => {
        const leave = router.subscribe('onBeforeNavigate', ({ toLocation }) => {
          try {
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
        // An explicit route reload replaces the read generation even at the same URL.
        const reload = router.subscribe('onBeforeLoad', retire);
        return () => {
          leave();
          reload();
        };
      },
    }),
    [router, initial.navigationKey, initial.generation, focus],
  );
  const returnPath = reporterHistoryReturnHref(search, initial.id) ?? '/moderation/reports';
  return (
    <ReporterStatusCurrent
      key={initial.generation}
      initial={initial}
      navigation={navigation}
      focus={focus}
      onReturn={async () => {
        focus.request(
          reporterHistoryQuery(Object.fromEntries(new URL(returnPath, 'https://local.invalid').searchParams)),
        );
        await router.navigate({ href: returnPath, resetScroll: false });
      }}
      {...(returnPath ? { returnHref: localizeHref(returnPath) } : {})}
    />
  );
}

function ReporterStatusRecovery({ state }: { state: 'loading' | 'concealed' }) {
  const search = Route.useSearch();
  const { id } = Route.useParams();
  const returnPath = reporterHistoryReturnHref(search, id) ?? '/moderation/reports';
  const router = useRouter();
  return (
    <ReporterStatusPage
      state={state}
      returnHref={localizeHref(returnPath)}
      onReturn={() => router.navigate({ href: returnPath })}
    />
  );
}
