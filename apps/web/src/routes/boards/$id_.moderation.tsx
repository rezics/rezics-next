import {
  createFileRoute,
  useNavigate,
  useRouter,
  useRouterState,
  type ErrorComponentProps,
} from '@tanstack/react-router';
import { ClosedErrorPage } from '../../shell/closed';
import { isPlatformClosedError } from '../../kernel/platform-closed';
import { requireSignedIn } from '../../session/guard';
import { pageHead } from '../../shell/head';
import { pageHeadContext } from '../../shell/head-context';
import { m } from '../../paraglide/messages.js';
import {
  loadModerationReports,
  moderationReportInput,
  reportPageIsCurrent,
  reportSelection,
  type ReportSelection,
} from '../../moderation/reports-read';
import { ModerationReportsView } from '../../moderation/reports-page';
import { loadModerationAppeals } from '../../moderation/appeals-read';
import { ModerationAppealsPage, ModerationAppealsView } from '../../moderation/appeals-tab';
import { appealReadKey, moderationAppealInput } from '../../moderation/appeals-read-model';

export const Route = createFileRoute('/boards/$id_/moderation')({
  beforeLoad: requireSignedIn,
  pendingMs: 0,
  pendingMinMs: 0,
  staleTime: 0,
  gcTime: 0,
  validateSearch: (search: Record<string, unknown>) => ({
    ...reportSelection(search),
    ...(typeof search.cursor === 'string' && search.cursor.length <= 4096 ? { cursor: search.cursor } : {}),
    ...(typeof search.thread === 'string' && search.thread.length <= 128 ? { thread: search.thread } : {}),
    ...(typeof search.post === 'string' && search.post.length <= 128 ? { post: search.post } : {}),
    ...(search.tab === 'appeals' ? { tab: 'appeals' as const } : {}),
  }),
  loaderDeps: ({ search }) => search,
  loader: async ({ params, deps, location, abortController }) => {
    if (deps.tab === 'appeals') {
      const page = await loadModerationAppeals({ data: moderationAppealInput(params.id, deps) });
      abortController.signal.throwIfAborted();
      return { ...page, navigationKey: location.state.__TSR_key ?? location.href };
    }
    return loadModerationReports({ data: moderationReportInput(params.id, deps) });
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
  const router = useRouter();
  const page = Route.useLoaderData();
  const { id } = Route.useParams();
  const search = Route.useSearch();
  const { thread, post, tab } = search;
  const selection = reportSelection(search);
  const latestLocation = useRouterState({ select: (state) => state.location });
  const latestSearch = latestLocation.search;
  const currentInput = moderationReportInput(id, latestSearch);
  const appealPage = page as Awaited<ReturnType<typeof loadModerationAppeals>> & { navigationKey: string };
  const appealInput = moderationAppealInput(id, latestSearch);
  const appealNavigationKey = latestLocation.state.__TSR_key ?? latestLocation.href;
  const reportPage = page as Awaited<ReturnType<typeof loadModerationReports>>;
  const onNext = (nextCursor: string) =>
    void navigate({
      to: '/boards/$id/moderation',
      params: { id },
      search: {
        ...selection,
        ...(thread ? { thread } : {}),
        ...(post ? { post } : {}),
        ...(tab ? { tab } : {}),
        cursor: nextCursor,
      },
    });
  return tab === 'appeals' ? (
    <ModerationAppealsPage
      key={`${appealPage.generation}:${appealPage.navigationKey}`}
      page={appealPage}
      input={appealInput}
      active={latestSearch.tab === 'appeals' && appealPage.navigationKey === appealNavigationKey}
      reportsSearch={`?${new URLSearchParams({ ...selection, ...(thread ? { thread } : {}), ...(post ? { post } : {}) })}`}
      onNext={onNext}
      onRestart={() =>
        void navigate({
          to: '/boards/$id/moderation',
          params: { id },
          search: { ...selection, tab: 'appeals', ...(thread ? { thread } : {}), ...(post ? { post } : {}) },
        })
      }
    />
  ) : (
    <ModerationReportsView
      key={`${reportPage.readKey}:${reportPage.viewerId}`}
      boardId={id}
      reports={reportPage.reports}
      selection={selection}
      viewerId={reportPage.viewerId}
      state={reportPageIsCurrent(reportPage, currentInput) ? reportPage.state : 'loading'}
      onSelection={(value) =>
        navigate({
          to: '/boards/$id/moderation',
          params: { id },
          search: { ...value, ...(thread ? { thread } : {}), ...(post ? { post } : {}) },
        })
      }
      onRestart={() =>
        void navigate({
          to: '/boards/$id/moderation',
          params: { id },
          search: { ...selection, ...(thread ? { thread } : {}), ...(post ? { post } : {}) },
        })
      }
      revisions={reportPage.revisions}
      targets={reportPage.targets}
      next={reportPage.next}
      tab="reports"
      {...(thread ? { threadId: thread } : {})}
      {...(post ? { postId: post } : {})}
      onNext={onNext}
      onRetry={() => void router.invalidate({ sync: true })}
      onRefresh={() => router.invalidate({ sync: true })}
    />
  );
}

function ModerationReportsPending() {
  const { id } = Route.useParams();
  const search = Route.useSearch();
  const { tab, thread, post } = search;
  const navigate = useNavigate();
  const selection = reportSelection(search);
  if (tab === 'appeals')
    return (
      <ModerationAppealsView appeals={[]} targets={[]} next={null} state="loading" threadId={thread} postId={post} />
    );
  return (
    <ModerationReportsView
      boardId={id}
      {...(thread ? { threadId: thread } : {})}
      {...(post ? { postId: post } : {})}
      selection={selection}
      onSelection={(value: ReportSelection) =>
        navigate({
          to: '/boards/$id/moderation',
          params: { id },
          search: { ...value, ...(thread ? { thread } : {}), ...(post ? { post } : {}) },
        })
      }
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
  const search = Route.useSearch();
  const { tab, thread, post } = search;
  const navigate = useNavigate();
  const selection = reportSelection(search);
  if (tab === 'appeals') {
    const input = moderationAppealInput(id, search);
    return (
      <ModerationAppealsPage
        page={{
          appeals: [],
          targets: [],
          next: null,
          viewerId: null,
          readKey: appealReadKey(input),
          generation: 'route-error',
          state: isPlatformClosedError(error) ? 'closed' : 'unavailable',
        }}
        input={input}
        reportsSearch={`?${new URLSearchParams({ ...selection, ...(thread ? { thread } : {}), ...(post ? { post } : {}) })}`}
      />
    );
  }
  if (isPlatformClosedError(error)) return <ClosedErrorPage error={error} />;
  return (
    <ModerationReportsView
      {...(thread ? { threadId: thread } : {})}
      {...(post ? { postId: post } : {})}
      boardId={id}
      selection={selection}
      onSelection={(value: ReportSelection) =>
        navigate({
          to: '/boards/$id/moderation',
          params: { id },
          search: { ...value, ...(thread ? { thread } : {}), ...(post ? { post } : {}) },
        })
      }
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
