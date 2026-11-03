import { useMemo } from 'react';
import { createFileRoute, useNavigate, useRouter, type ErrorComponentProps } from '@tanstack/react-router';
import { requireSignedIn } from '../../session/guard';
import { pageHead } from '../../shell/head';
import { pageHeadContext } from '../../shell/head-context';
import { m } from '../../paraglide/messages.js';
import { isPlatformClosedError } from '../../kernel/platform-closed';
import { ClosedErrorPage } from '../../shell/closed';
import {
  loadWorkbench,
  prepareWorkbenchRead,
  workbenchSearch,
  WorkbenchPage,
  WorkbenchPreparing,
  WorkbenchView,
  type WorkbenchSearch,
} from '../../moderation/workbench-queue';

export const Route = createFileRoute('/moderation/workbench')({
  beforeLoad: requireSignedIn,
  pendingMs: 0,
  pendingMinMs: 0,
  staleTime: 0,
  gcTime: 0,
  validateSearch: workbenchSearch,
  loaderDeps: ({ search }) => search,
  loader: async ({ deps, abortController, context, location }) => {
    const page = await prepareWorkbenchRead(
      context.queryClient,
      deps,
      (data) => loadWorkbench({ data }),
      abortController.signal,
    );
    return { ...page, navigationKey: location.state.__TSR_key ?? location.href };
  },
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
  const navigation = useMemo(
    () => ({
      isCurrent: () => (router.state.location.state.__TSR_key ?? router.state.location.href) === page.navigationKey,
      subscribe: (retire: () => void) => {
        const leave = router.subscribe('onBeforeNavigate', ({ toLocation }) => {
          if ((toLocation.state.__TSR_key ?? toLocation.href) !== page.navigationKey) retire();
        });
        const reload = router.subscribe('onBeforeLoad', retire);
        return () => {
          leave();
          reload();
        };
      },
    }),
    [router, page.navigationKey, page.generation],
  );
  const onSearch = (next: WorkbenchSearch) => void navigate({ search: workbenchSearch(next) });
  return (
    <WorkbenchPage
      key={`${page.generation}:${page.navigationKey}`}
      page={page}
      search={search}
      navigation={navigation}
      onSearch={onSearch}
      onRetry={() => void router.invalidate({ sync: true })}
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
