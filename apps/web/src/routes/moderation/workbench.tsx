import { createFileRoute, useNavigate, useRouter, type ErrorComponentProps } from '@tanstack/react-router';
import { requireSignedIn } from '../../session/guard';
import { pageHead } from '../../shell/head';
import { pageHeadContext } from '../../shell/head-context';
import { m } from '../../paraglide/messages.js';
import { isPlatformClosedError } from '../../kernel/platform-closed';
import { ClosedErrorPage } from '../../shell/closed';
import { createWorkbenchLoader } from '../../moderation/workbench-queue/route-loader';
import { WorkbenchRoutePage } from '../../moderation/workbench-queue/route-page';
import { workbenchSearch } from '../../moderation/workbench-queue/scope';
import { WorkbenchPreparing, WorkbenchView } from '../../moderation/workbench-queue/view';

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
  return <WorkbenchRoutePage page={Route.useLoaderData()} search={Route.useSearch()} />;
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
