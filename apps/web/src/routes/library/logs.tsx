import { createFileRoute } from '@tanstack/react-router';
import { MyLogsCurrentViewer } from '../../library/my-logs-page';
import { myLogsSearch } from '../../library/my-logs';
import { readMyPublishedLogHistoryForViewer } from '../../library/logs-server';
import { m } from '../../paraglide/messages.js';
import { requireSignedIn } from '../../session/guard';
import { pageHead } from '../../shell/head';
import { pageHeadContext } from '../../shell/head-context';

export const Route = createFileRoute('/library/logs')({
  beforeLoad: requireSignedIn,
  validateSearch: myLogsSearch,
  loaderDeps: ({ search }) => myLogsSearch(search),
  loader: ({ deps }) =>
    deps.invalidPosition
      ? { sessionSubject: null, cursor: null, locale: '', page: { state: 'invalid-position' as const } }
      : readMyPublishedLogHistoryForViewer({ data: deps }),
  staleTime: 0,
  gcTime: 0,
  head: ({ match }) =>
    pageHead({ title: m.library_my_logs_heading(), robots: 'noindex, nofollow' }, pageHeadContext(match.pathname)),
  component: MyLogsRoute,
});

function MyLogsRoute() {
  const search = Route.useSearch();
  return (
    <MyLogsCurrentViewer
      initial={Route.useLoaderData()}
      cursor={search.cursor}
      invalidPosition={search.invalidPosition === true}
    />
  );
}
