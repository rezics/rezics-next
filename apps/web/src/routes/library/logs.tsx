import { createFileRoute, useRouter } from '@tanstack/react-router';
import { MyLogsPageView } from '../../library/my-logs-page';
import { myLogsSearch } from '../../library/my-logs';
import { readMyPublishedLogHistory } from '../../library/logs-server';
import { m } from '../../paraglide/messages.js';
import { requireSignedIn } from '../../session/guard';
import { pageHead } from '../../shell/head';
import { pageHeadContext } from '../../shell/head-context';

export const Route = createFileRoute('/library/logs')({
  beforeLoad: requireSignedIn,
  validateSearch: myLogsSearch,
  loaderDeps: ({ search }) => myLogsSearch(search),
  loader: ({ deps }) => readMyPublishedLogHistory({ data: deps }),
  staleTime: 0,
  gcTime: 0,
  head: ({ match }) =>
    pageHead({ title: m.library_my_logs_heading(), robots: 'noindex, nofollow' }, pageHeadContext(match.pathname)),
  component: MyLogsRoute,
});

function MyLogsRoute() {
  const router = useRouter();
  return (
    <MyLogsPageView
      page={Route.useLoaderData()}
      cursor={Route.useSearch().cursor}
      onRetry={() => void router.invalidate()}
    />
  );
}
