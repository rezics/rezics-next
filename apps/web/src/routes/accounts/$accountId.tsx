import { createFileRoute, Outlet, useRouter, useRouterState } from '@tanstack/react-router';
import { requireSignedIn } from '../../session/guard';
import { pageHead } from '../../shell/head';
import { pageHeadContext } from '../../shell/head-context';
import { m } from '../../paraglide/messages.js';
import { readAccountManagement } from '../../accounts/management/actions';
import { readManagementWindow, useManagementWindow } from '../../accounts/management/window-route';
import { readCursors } from '../../accounts/management/data';
import { AccountManagementPage } from '../../accounts/management/pages';

export const Route = createFileRoute('/accounts/$accountId')({
  beforeLoad: requireSignedIn,
  validateSearch: readCursors,
  loaderDeps: ({ search }) => search,
  gcTime: 0,
  loader: ({ params, deps, abortController, context }) =>
    readManagementWindow(context.queryClient, () =>
      readAccountManagement({ data: { accountId: params.accountId, ...deps }, signal: abortController.signal }),
    ),
  head: ({ match }) =>
    pageHead({ title: m.managed_detail_title(), robots: 'noindex, nofollow' }, pageHeadContext(match.pathname)),
  component: AccountRoute,
});
function AccountRoute() {
  const router = useRouter();
  const cursors = Route.useSearch();
  const window = useManagementWindow({
    read: Route.useLoaderData(),
    cursors,
    target: Route.useParams().accountId,
    navigate: (search) => {
      void router.navigate({ to: '.', search });
    },
    retry: () => {
      void router.invalidate();
    },
  });
  const hasChild = useRouterState({ select: (state) => state.matches.at(-1)?.routeId !== Route.id });
  if (hasChild) return <Outlet />;
  return (
    <AccountManagementPage page={window.page} cursors={cursors} navigation={window.navigation} retry={window.retry} />
  );
}
