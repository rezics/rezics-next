import { useEffect, useMemo, useRef } from 'react';
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
  prepareModerationReportRead,
  reportSelection,
  type ReportSelection,
} from '../../moderation/reports-read';
import { ModerationReportsPage, ModerationReportsView } from '../../moderation/reports-page';
import { loadModerationAppeals } from '../../moderation/appeals-read';
import { ModerationAppealsPage, ModerationAppealsView } from '../../moderation/appeals-tab';
import {
  appealNavigationContext,
  moderationAppealInput,
  prepareModerationAppealRead,
} from '../../moderation/appeals-read-model';

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
  loaderDeps: ({ search }) =>
    search.tab === 'appeals'
      ? { tab: search.tab, thread: search.thread, post: search.post, cursor: search.cursor }
      : search,
  // Reports selection metadata does not replace a loaded Appeals queue; explicit refresh stays page-owned.
  shouldReload: ({ deps }) => deps.tab !== 'appeals',
  loader: async ({ params, deps, location, abortController, context }) => {
    if (deps.tab === 'appeals') {
      const page = await prepareModerationAppealRead(
        context.queryClient,
        moderationAppealInput(params.id, deps),
        (data) => loadModerationAppeals({ data }),
        abortController.signal,
      );
      return { ...page, navigationKey: appealNavigationContext(location) };
    }
    const page = await prepareModerationReportRead(
      context.queryClient,
      moderationReportInput(params.id, deps),
      (data) => loadModerationReports({ data }),
      abortController.signal,
    );
    return { ...page, navigationKey: location.state.__TSR_key ?? location.href };
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
  const appealNavigationKey =
    tab === 'appeals'
      ? appealNavigationContext(latestLocation)
      : (latestLocation.state.__TSR_key ?? latestLocation.href);
  const reportPage = page as Awaited<ReturnType<typeof prepareModerationReportRead>> & { navigationKey: string };
  const reportNavigation = useMemo(() => {
    const key = (location: typeof router.state.location) =>
      tab === 'appeals' ? appealNavigationContext(location) : (location.state.__TSR_key ?? location.href);
    return {
      isCurrent: () => key(router.state.location) === reportPage.navigationKey,
      subscribe: (retire: () => void) => {
        const leave = router.subscribe('onBeforeNavigate', ({ toLocation }) => {
          if (key(toLocation) !== reportPage.navigationKey) retire();
        });
        const reload = router.subscribe('onBeforeLoad', ({ toLocation }) => {
          if (tab !== 'appeals' || key(toLocation) !== reportPage.navigationKey) retire();
        });
        return () => {
          leave();
          reload();
        };
      },
    };
  }, [router, reportPage.generation, reportPage.navigationKey, tab]);
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
      navigation={reportNavigation}
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
    <ModerationReportsPage
      page={reportPage}
      input={currentInput}
      active={latestSearch.tab !== 'appeals' && reportPage.navigationKey === appealNavigationKey}
      navigation={reportNavigation}
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
      <ModerationAppealsView
        appeals={[]}
        targets={[]}
        next={null}
        state="loading"
        {...(thread ? { threadId: thread } : {})}
        {...(post ? { postId: post } : {})}
      />
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
  const original = useRef({ location: router.state.location, active: true });
  const pending = useRef(false);
  useEffect(() => {
    original.current.active = true;
    return () => {
      original.current.active = false;
    };
  }, []);
  const current = () => original.current.active && router.state.location === original.current.location;
  const retry = () => {
    if (!current() || pending.current) return;
    pending.current = true;
    void router
      .invalidate({ sync: true })
      .then(() => {
        if (current()) reset();
      })
      .catch(() => {
        /* The loader owns the current safe error result. */
      })
      .finally(() => {
        if (current()) pending.current = false;
      });
  };
  if (tab === 'appeals') {
    return (
      <ModerationAppealsView
        appeals={[]}
        targets={[]}
        next={null}
        state={isPlatformClosedError(error) ? 'closed' : 'unavailable'}
        {...(thread ? { threadId: thread } : {})}
        {...(post ? { postId: post } : {})}
        onRetry={retry}
        onNext={(cursor) => {
          if (!current()) return;
          void navigate({
            to: '/boards/$id/moderation',
            params: { id },
            search: { ...selection, tab: 'appeals', ...(thread ? { thread } : {}), ...(post ? { post } : {}), cursor },
          });
        }}
        onRestart={() => {
          if (!current()) return;
          void navigate({
            to: '/boards/$id/moderation',
            params: { id },
            search: { ...selection, tab: 'appeals', ...(thread ? { thread } : {}), ...(post ? { post } : {}) },
          });
        }}
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
      onRetry={retry}
    />
  );
}
