import { createFileRoute, useRouter } from '@tanstack/react-router';
import { requireSignedIn } from '../../session/guard';
import { pageHead } from '../../shell/head';
import { pageHeadContext } from '../../shell/head-context';
import { m } from '../../paraglide/messages.js';
import { readManagedAccounts } from '../../accounts/management/actions';
import { readManagementWindow, useManagementWindow } from '../../accounts/management/window-route';
import { readCursors } from '../../accounts/management/data';
import { ManagedAccountsPage } from '../../accounts/management/pages';

export const Route = createFileRoute('/accounts/')({
  beforeLoad: requireSignedIn,
  validateSearch: readCursors,
  loaderDeps: ({ search }) => search,
  gcTime: 0,
  loader: ({ deps, abortController, context }) =>
    readManagementWindow(context.queryClient, () =>
      readManagedAccounts({ data: deps, signal: abortController.signal }),
    ),
  head: ({ match }) =>
    pageHead({ title: m.managed_title(), robots: 'noindex, nofollow' }, pageHeadContext(match.pathname)),
  component: AccountsRoute,
});
function AccountsRoute() {
  const router = useRouter();
  const cursors = Route.useSearch();
  const window = useManagementWindow({
    read: Route.useLoaderData(),
    cursors,
    target: 'inventory',
    navigate: (search) => {
      void router.navigate({ to: '.', search });
    },
    retry: () => {
      void router.invalidate();
    },
  });
  return (
    <ManagedAccountsPage page={window.page} cursors={cursors} navigation={window.navigation} retry={window.retry} />
  );
}
