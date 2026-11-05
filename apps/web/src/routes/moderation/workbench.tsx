import { useContext, useMemo } from 'react';
import { QueryClientContext } from '@tanstack/react-query';
import { createFileRoute, useNavigate, useRouter, type ErrorComponentProps } from '@tanstack/react-router';
import { requireSignedIn } from '../../session/guard';
import { pageHead } from '../../shell/head';
import { pageHeadContext } from '../../shell/head-context';
import { getLocale } from '../../paraglide/runtime.js';
import { m } from '../../paraglide/messages.js';
import { isPlatformClosedError } from '../../kernel/platform-closed';
import { ClosedErrorPage } from '../../shell/closed';
import {
  workbenchSearch,
  WorkbenchPage,
  WorkbenchPreparing,
  WorkbenchView,
  type WorkbenchSearch,
} from '../../moderation/workbench-queue';
import { createWorkbenchLoader } from '../../moderation/workbench-queue/route-loader';
import { workbenchQueueWindowHistory } from '../../moderation/workbench-queue/window-history';

export const Route = createFileRoute('/moderation/workbench')({
  beforeLoad: requireSignedIn,
  pendingMs: 0,
  pendingMinMs: 0,
  staleTime: 0,
  gcTime: 0,
  validateSearch: workbenchSearch,
  loaderDeps: ({ search }) => search,
  loader: createWorkbenchLoader(),
  head: ({ match }) =>
    pageHead({ title: m.moderation_workbench_heading(), robots: 'noindex, nofollow' }, pageHeadContext(match.pathname)),
  pendingComponent: WorkbenchPreparing,
  errorComponent: WorkbenchError,
  component: WorkbenchRoute,
});

function WorkbenchRoute() {
  const page = Route.useLoaderData();
  const search = Route.useSearch();
  const navigate = useNavigate({ from: '/moderation/workbench' });
  const router = useRouter();
  const client = useContext(QueryClientContext);
  const windowHistory = client ? workbenchQueueWindowHistory(client) : undefined;
  const visitId = useMemo(() => crypto.randomUUID(), [page.navigationKey]);
  const navigation = useMemo(
    () => ({
      visitId,
      isCurrent: () =>
        getLocale() === page.locale &&
        (router.state.location.state.__TSR_key ?? router.state.location.href) === page.navigationKey,
      subscribe: (retire: () => void) => {
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
    [router, page.navigationKey, page.generation, page.locale, page, search, visitId, windowHistory],
  );
  const onSearch = (next: WorkbenchSearch) => void navigate({ search: workbenchSearch(next) });
  return (
    <WorkbenchPage
      key={`${page.generation}:${page.navigationKey}`}
      page={page}
      search={search}
      navigation={navigation}
      onSearch={onSearch}
      onOpenCase={(_item, href) => void router.navigate({ to: href as never })}
      onRetry={() => void router.invalidate({ sync: true })}
      onRefresh={() => router.invalidate({ sync: true })}
    />
  );
}

function WorkbenchError({ error, reset }: ErrorComponentProps) {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: '/moderation/workbench' });
  const router = useRouter();
  if (isPlatformClosedError(error)) return <ClosedErrorPage error={error} />;
  return (
    <WorkbenchView
      page={{
        state: 'unavailable',
        search,
        realms: [],
        realmsNext: null,
        boards: [],
        boardsNext: null,
        cases: [],
        next: null,
      }}
      onSearch={(next) => void navigate({ search: workbenchSearch(next) })}
      onRetry={() =>
        void router.invalidate({ sync: true }).then(
          () => reset(),
          () => undefined,
        )
      }
    />
  );
}
