import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { requireSignedIn } from '../../session/guard';
import { pageHead } from '../../shell/head';
import { pageHeadContext } from '../../shell/head-context';
import { m } from '../../paraglide/messages.js';
import { loadModerationReports } from '../../moderation/reports-read';
import { ModerationReportsView } from '../../moderation/reports-page';

export const Route = createFileRoute('/boards/$id_/moderation')({
  beforeLoad: requireSignedIn,
  validateSearch: (search: Record<string, unknown>) => ({
    ...(typeof search.cursor === 'string' && search.cursor.length <= 4096 ? { cursor: search.cursor } : {}),
    ...(typeof search.thread === 'string' && search.thread.length <= 128 ? { thread: search.thread } : {}),
  }),
  loaderDeps: ({ search }) => search,
  loader: async ({ params, deps }) =>
    loadModerationReports({
      data: {
        boardId: params.id,
        ...(deps.cursor ? { cursor: deps.cursor } : {}),
        ...(deps.thread ? { threadId: deps.thread } : {}),
      },
    }),
  head: ({ match }) =>
    pageHead({ title: m.moderation_reports_heading(), robots: 'noindex, nofollow' }, pageHeadContext(match.pathname)),
  component: ModerationReportsRoute,
});

function ModerationReportsRoute() {
  const navigate = useNavigate();
  const { reports, targets, next } = Route.useLoaderData();
  const { id } = Route.useParams();
  const { thread, cursor } = Route.useSearch();
  return (
    <ModerationReportsView
      reports={reports}
      targets={targets}
      next={next}
      threadId={thread}
      onNext={(nextCursor) =>
        void navigate({
          to: '/boards/$id_/moderation',
          params: { id },
          search: { ...(thread ? { thread } : {}), cursor: nextCursor },
        })
      }
    />
  );
}
