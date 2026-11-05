import { createFileRoute, notFound, useNavigate, useRouter } from '@tanstack/react-router';
import { useContext, useMemo } from 'react';
import { QueryClientContext } from '@tanstack/react-query';
import { localizeHref } from '../../paraglide/runtime.js';
import { loadModerationReports, prepareModerationReportRead } from '../../moderation/reports-read';
import type { ReportNavigation } from '../../moderation/reports-page';
import { WorkbenchCasePage, WorkbenchCaseStatus } from '../../moderation/workbench-case';
import {
  parseWorkbenchCaseSearch,
  workbenchCaseQueueHref,
  workbenchCaseInput,
  type WorkbenchCaseSearch,
} from '../../moderation/workbench-case/read-model';
import { m } from '../../paraglide/messages.js';
import { requireSignedIn } from '../../session/guard';
import { pageHead } from '../../shell/head';
import { pageHeadContext } from '../../shell/head-context';
import { workbenchQueueWindowHistory } from '../../moderation/workbench-queue/window-history';

export const Route = createFileRoute('/moderation/cases/$id')({
  beforeLoad: requireSignedIn,
  validateSearch: (search: Record<string, unknown>): WorkbenchCaseSearch => {
    const parsed = parseWorkbenchCaseSearch(search);
    if (!parsed) throw notFound();
    return parsed;
  },
  pendingMs: 0,
  pendingMinMs: 0,
  staleTime: 0,
  gcTime: 0,
  loaderDeps: ({ search }) => search,
  loader: async ({ params, deps, context, abortController, location }) => {
    if (!params.id || params.id.length > 128) throw notFound();
    const input = workbenchCaseInput(deps, params.id);
    const page = await prepareModerationReportRead(
      context.queryClient,
      input,
      (data) => loadModerationReports({ data }),
      abortController.signal,
    );
    return Object.assign(page, { navigationKey: location.state.__TSR_key ?? location.href });
  },
  head: ({ match }) =>
    pageHead({ title: m.moderation_reports_heading(), robots: 'noindex, nofollow' }, pageHeadContext(match.pathname)),
  pendingComponent: WorkbenchCasePending,
  errorComponent: WorkbenchCaseError,
  component: WorkbenchCaseRoute,
});

function WorkbenchCaseRoute() {
  const page = Route.useLoaderData();
  const { id } = Route.useParams();
  const search = Route.useSearch();
  const router = useRouter();
  const navigate = useNavigate({ from: '/moderation/cases/$id' });
  const client = useContext(QueryClientContext);
  const windowHistory = client ? workbenchQueueWindowHistory(client) : undefined;
  const visitId = useMemo(() => crypto.randomUUID(), [page.navigationKey]);
  const navigation = useMemo<ReportNavigation & { visitId: string }>(
    () => ({
      visitId,
      isCurrent: () => (router.state.location.state.__TSR_key ?? router.state.location.href) === page.navigationKey,
      subscribe: (retire) => {
        const leave = router.subscribe('onBeforeNavigate', ({ toLocation }) => {
          if ((toLocation.state.__TSR_key ?? toLocation.href) !== page.navigationKey) {
            windowHistory?.navigate(
              visitId,
              { pathname: toLocation.pathname, search: toLocation.search as Record<string, unknown> },
              search,
              page,
            );
            retire();
          }
        });
        const reload = router.subscribe('onBeforeLoad', retire);
        return () => {
          leave();
          reload();
        };
      },
    }),
    [router, page.navigationKey, page.generation, page, search, visitId, windowHistory],
  );
  const input = workbenchCaseInput(search, id);
  return (
    <WorkbenchCasePage
      key={page.generation}
      page={page}
      reportId={id}
      input={input}
      search={search}
      navigation={navigation}
      onReturnQueue={(href) => void router.navigate({ to: href as never })}
      onRefresh={() => router.invalidate({ sync: true })}
      onRetry={() => void router.invalidate({ sync: true })}
      onRestart={() => {
        const { cursor: _cursor, ...rest } = search;
        void navigate({ to: '/moderation/cases/$id', params: { id }, search: rest });
      }}
    />
  );
}

function WorkbenchCasePending() {
  const search = Route.useSearch();
  const parsed = parseWorkbenchCaseSearch(search);
  const queueHref = localizeHref(parsed ? workbenchCaseQueueHref(parsed) : '/moderation/workbench');
  return <WorkbenchCaseStatus state="loading" queueHref={queueHref} />;
}

function WorkbenchCaseError() {
  const router = useRouter();
  const search = Route.useSearch();
  const parsed = parseWorkbenchCaseSearch(search);
  const queueHref = localizeHref(parsed ? workbenchCaseQueueHref(parsed) : '/moderation/workbench');
  return (
    <WorkbenchCaseStatus state="error" queueHref={queueHref} onRetry={() => void router.invalidate({ sync: true })} />
  );
}
