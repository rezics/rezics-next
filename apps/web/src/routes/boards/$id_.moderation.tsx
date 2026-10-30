import { createFileRoute, useNavigate, useRouter, type ErrorComponentProps } from '@tanstack/react-router';
import { PendingPage } from '../../shell/pending';
import { ClosedErrorPage } from '../../shell/closed';
import { isPlatformClosedError } from '../../kernel/platform-closed';
import { requireSignedIn } from '../../session/guard';
import { pageHead } from '../../shell/head';
import { pageHeadContext } from '../../shell/head-context';
import { m } from '../../paraglide/messages.js';
import { loadModerationReports } from '../../moderation/reports-read';
import { ModerationReportsView } from '../../moderation/reports-page';
import { loadModerationAppeals } from '../../moderation/appeals-read';
import { ModerationAppealsView } from '../../moderation/appeals-tab';

export const Route = createFileRoute('/boards/$id_/moderation')({
  beforeLoad: requireSignedIn,
  validateSearch: (search: Record<string, unknown>) => ({
    ...(typeof search.cursor === 'string' && search.cursor.length <= 4096 ? { cursor: search.cursor } : {}),
    ...(typeof search.thread === 'string' && search.thread.length <= 128 ? { thread: search.thread } : {}),
    ...(typeof search.post === 'string' && search.post.length <= 128 ? { post: search.post } : {}),
    ...(search.tab === 'appeals' ? { tab: 'appeals' as const } : {}),
  }),
  loaderDeps: ({ search }) => search,
  loader: async ({ params, deps }) => {
    const input = {
      boardId: params.id,
      ...(deps.cursor ? { cursor: deps.cursor } : {}),
      ...(deps.thread ? { threadId: deps.thread } : {}),
    };
    return deps.tab === 'appeals'
      ? loadModerationAppeals({ data: input })
      : loadModerationReports({ data: { ...input, ...(deps.post ? { postId: deps.post } : {}) } });
  },
  head: ({ match }) =>
    pageHead(
      {
        title: match.search.tab === 'appeals' ? m.moderation_appeals_heading() : m.moderation_reports_heading(),
        robots: 'noindex, nofollow',
      },
      pageHeadContext(match.pathname),
    ),
  pendingComponent: ModerationReportsPending,
  errorComponent: ModerationReportsError,
  component: ModerationReportsRoute,
});

function ModerationReportsRoute() {
  const navigate = useNavigate();
  const page = Route.useLoaderData();
  const { id } = Route.useParams();
  const { thread, post, cursor, tab } = Route.useSearch();
  const appealPage = page as Awaited<ReturnType<typeof loadModerationAppeals>>;
  const reportPage = page as Awaited<ReturnType<typeof loadModerationReports>>;
  const onNext = (nextCursor: string) =>
    void navigate({
      to: '/boards/$id/moderation',
      params: { id },
      search: { ...(thread ? { thread } : {}), ...(post ? { post } : {}), ...(tab ? { tab } : {}), cursor: nextCursor },
    });
  return tab === 'appeals' ? (
    <ModerationAppealsView
      appeals={appealPage.appeals}
      targets={appealPage.targets}
      next={appealPage.next}
      {...(thread ? { threadId: thread } : {})}
      {...(post ? { postId: post } : {})}
      onNext={onNext}
    />
  ) : (
    <ModerationReportsView
      key={`${id}:${thread ?? ''}:${post ?? ''}:${cursor ?? ''}`}
      boardId={id}
      reports={reportPage.reports}
      revisions={reportPage.revisions}
      targets={reportPage.targets}
      next={reportPage.next}
      tab="reports"
      {...(thread ? { threadId: thread } : {})}
      {...(post ? { postId: post } : {})}
      onNext={onNext}
    />
  );
}

function ModerationReportsPending() {
  const { id } = Route.useParams();
  const { tab, thread, post } = Route.useSearch();
  if (tab === 'appeals') return <PendingPage />;
  return (
    <ModerationReportsView
      boardId={id}
      {...(thread ? { threadId: thread } : {})}
      {...(post ? { postId: post } : {})}
      reports={[]}
      targets={[]}
      next={null}
      state="loading"
    />
  );
}

function ModerationReportsError({ reset, error }: ErrorComponentProps) {
  const { id } = Route.useParams();
  const router = useRouter();
  const { tab, thread, post } = Route.useSearch();
  if (tab === 'appeals' || isPlatformClosedError(error)) return <ClosedErrorPage error={error} />;
  return (
    <ModerationReportsView
      {...(thread ? { threadId: thread } : {})}
      {...(post ? { postId: post } : {})}
      boardId={id}
      reports={[]}
      targets={[]}
      next={null}
      state="error"
      onRetry={() => {
        void router.invalidate().then(reset);
      }}
    />
  );
}
