import { createFileRoute, useRouter } from '@tanstack/react-router';
import { readReporterStatus } from '../../moderation/reporter-status-read';
import { ReporterStatusPage } from '../../moderation/reporter-status-view';
import { m } from '../../paraglide/messages.js';
import { requireSignedIn } from '../../session/guard';
import { pageHead } from '../../shell/head';
import { pageHeadContext } from '../../shell/head-context';

export const Route = createFileRoute('/moderation/reports/$id')({
  beforeLoad: requireSignedIn,
  loader: ({ params }) => readReporterStatus({ data: { id: params.id } }),
  head: ({ match }) =>
    pageHead({ title: m.reporter_status_heading(), robots: 'noindex, nofollow' }, pageHeadContext(match.pathname)),
  component: ReporterStatusRoute,
  errorComponent: ReporterStatusError,
});

function ReporterStatusRoute() {
  return <ReporterStatusPage report={Route.useLoaderData()} />;
}

function ReporterStatusError() {
  const router = useRouter();
  return <ReporterStatusPage onRetry={() => router.invalidate()} />;
}
