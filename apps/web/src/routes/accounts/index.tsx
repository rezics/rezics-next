import { createFileRoute, useRouter } from '@tanstack/react-router';
import { requireSignedIn } from '../../session/guard';
import { pageHead } from '../../shell/head';
import { pageHeadContext } from '../../shell/head-context';
import { m } from '../../paraglide/messages.js';
import { readManagedAccounts } from '../../accounts/management/actions';
import { readCursors } from '../../accounts/management/data';
import { ManagedAccountsPage } from '../../accounts/management/pages';

export const Route = createFileRoute('/accounts/')({
  beforeLoad: requireSignedIn,
  validateSearch: readCursors,
  loaderDeps: ({ search }) => search,
  loader: ({ deps, abortController }) => readManagedAccounts({ data: deps, signal: abortController.signal }),
  head: ({ match }) =>
    pageHead({ title: m.managed_title(), robots: 'noindex, nofollow' }, pageHeadContext(match.pathname)),
  component: AccountsRoute,
});
function AccountsRoute() {
  const router = useRouter();
  return (
    <ManagedAccountsPage
      page={Route.useLoaderData()}
      cursors={Route.useSearch()}
      retry={() => {
        void router.invalidate();
      }}
    />
  );
}
