import { createFileRoute } from '@tanstack/react-router';
import { readReporterStatus } from '../../moderation/reporter-status-read';
import { prepareReporterStatusRead } from '../../moderation/reporter-status-read-model';
import { ReporterStatusCurrent, ReporterStatusPage } from '../../moderation/reporter-status-view';
import { m } from '../../paraglide/messages.js';
import { requireSignedIn } from '../../session/guard';
import { pageHead } from '../../shell/head';
import { pageHeadContext } from '../../shell/head-context';

export const Route = createFileRoute('/moderation/reports/$id')({
  beforeLoad: requireSignedIn,
  loader: ({ params, context, abortController }) =>
    prepareReporterStatusRead(
      context.queryClient,
      params.id,
      (data) => readReporterStatus({ data }),
      abortController.signal,
    ),
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
  return <ReporterStatusCurrent key={initial.generation} initial={initial} />;
}
