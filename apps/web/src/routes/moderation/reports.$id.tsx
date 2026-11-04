import { useMemo } from 'react';
import { createFileRoute, useRouter } from '@tanstack/react-router';
import { readReporterStatus } from '../../moderation/reporter-status-read';
import { prepareReporterStatusRead } from '../../moderation/reporter-status-read-model';
import { reporterHistoryReturnHref } from '../../moderation/reporter-history/navigation';
import { ReporterStatusCurrent, ReporterStatusPage } from '../../moderation/reporter-status-view';
import { m } from '../../paraglide/messages.js';
import { localizeHref } from '../../paraglide/runtime.js';
import { requireSignedIn } from '../../session/guard';
import { pageHead } from '../../shell/head';
import { pageHeadContext } from '../../shell/head-context';

export const Route = createFileRoute('/moderation/reports/$id')({
  beforeLoad: requireSignedIn,
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
  pendingComponent: () => <ReporterStatusPage state="loading" />,
  head: ({ match }) =>
    pageHead({ title: m.reporter_status_heading(), robots: 'noindex, nofollow' }, pageHeadContext(match.pathname)),
  component: ReporterStatusRoute,
  errorComponent: () => <ReporterStatusPage state="concealed" />,
});

function ReporterStatusRoute() {
  const initial = Route.useLoaderData();
  const search = Route.useSearch();
  const router = useRouter();
  const navigation = useMemo(
    () => ({
      isCurrent: () => (router.state.location.state.__TSR_key ?? router.state.location.href) === initial.navigationKey,
      subscribe: (retire: () => void) => {
        const leave = router.subscribe('onBeforeNavigate', ({ toLocation }) => {
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
    [router, initial.navigationKey, initial.generation],
  );
  const returnPath = reporterHistoryReturnHref(search, initial.id);
  return (
    <ReporterStatusCurrent
      key={initial.generation}
      initial={initial}
      navigation={navigation}
      {...(returnPath ? { returnHref: localizeHref(returnPath) } : {})}
    />
  );
}
