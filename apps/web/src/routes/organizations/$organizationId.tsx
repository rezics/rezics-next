import { createFileRoute, useRouter } from '@tanstack/react-router';
import { requireSignedIn } from '../../session/guard';
import { pageHead } from '../../shell/head';
import { pageHeadContext } from '../../shell/head-context';
import { m } from '../../paraglide/messages.js';
import { readAccountManagement } from '../../accounts/management/actions';
import { readCursors } from '../../accounts/management/data';
import { AccountManagementPage } from '../../accounts/management/pages';

export const Route = createFileRoute('/organizations/$organizationId')({
  beforeLoad: requireSignedIn,
  validateSearch: readCursors,
  loaderDeps: ({ search }) => search,
  loader: ({ params, deps, abortController }) =>
    readAccountManagement({ data: { accountId: params.organizationId, ...deps }, signal: abortController.signal }),
  head: ({ match }) =>
    pageHead({ title: m.managed_detail_title(), robots: 'noindex, nofollow' }, pageHeadContext(match.pathname)),
  component: OrganizationRoute,
});
function OrganizationRoute() {
  const router = useRouter();
  return (
    <AccountManagementPage
      page={Route.useLoaderData()}
      cursors={Route.useSearch()}
      retry={() => {
        void router.invalidate();
      }}
    />
  );
}
