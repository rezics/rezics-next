import { createFileRoute, useRouter } from '@tanstack/react-router';
import { requireSignedIn } from '../../session/guard';
import { pageHead } from '../../shell/head';
import { pageHeadContext } from '../../shell/head-context';
import { m } from '../../paraglide/messages.js';
import { readAccountManagement } from '../../accounts/management/actions';
import { readManagementWindow, useManagementWindow } from '../../accounts/management/window-route';
import { readCursors } from '../../accounts/management/data';
import { AccountManagementPage } from '../../accounts/management/pages';

export const Route = createFileRoute('/organizations/$organizationId')({
  beforeLoad: requireSignedIn,
  validateSearch: readCursors,
  loaderDeps: ({ search }) => search,
  gcTime: 0,
  loader: ({ params, deps, abortController, context }) =>
    readManagementWindow(context.queryClient, params.organizationId, () =>
      readAccountManagement({ data: { accountId: params.organizationId, ...deps }, signal: abortController.signal }),
    ),
  head: ({ match }) =>
    pageHead({ title: m.managed_detail_title(), robots: 'noindex, nofollow' }, pageHeadContext(match.pathname)),
  component: OrganizationRoute,
});
function OrganizationRoute() {
  const router = useRouter();
  const cursors = Route.useSearch();
  const window = useManagementWindow({
    read: Route.useLoaderData(),
    cursors,
    target: Route.useParams().organizationId,
    navigate: (search) => {
      void router.navigate({ to: '.', search });
    },
    retry: () => {
      void router.invalidate();
    },
  });
  return (
    <AccountManagementPage page={window.page} cursors={cursors} navigation={window.navigation} retry={window.retry} />
  );
}
