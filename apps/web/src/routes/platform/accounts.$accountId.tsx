import { Outlet, useRouterState, createFileRoute } from '@tanstack/react-router';
import { changeAccountLifecycle, readAccountLifecycle } from '../../accounts/lifecycle-controls/actions';
import { AccountLifecyclePage } from '../../accounts/lifecycle-controls/page';
import { m } from '../../paraglide/messages.js';
import { requireSignedIn } from '../../session/guard';
import { useSession } from '../../session/query';
import { pageHead } from '../../shell/head';
import { pageHeadContext } from '../../shell/head-context';

export const Route = createFileRoute('/platform/accounts/$accountId')({
  beforeLoad: requireSignedIn,
  loader: ({ params, location }) =>
    /\/erasure\/?$/.test(location.pathname) ? null : readAccountLifecycle({ data: { accountId: params.accountId } }),
  head: ({ match }) =>
    pageHead({ title: m.lifecycle_title(), robots: 'noindex, nofollow' }, pageHeadContext(match.pathname)),
  component: AccountRoute,
});
function AccountRoute() {
  const erasure = useRouterState({
    select: (state) => state.matches.some((match) => match.routeId === '/platform/accounts/$accountId/erasure'),
  });
  return erasure ? <Outlet /> : <LifecycleRoute />;
}
function LifecycleRoute() {
  const initial = Route.useLoaderData();
  const { accountId } = Route.useParams();
  const { csrfToken } = useSession();
  return (
    <AccountLifecyclePage
      key={accountId}
      initial={initial ?? { status: 'unavailable' }}
      io={{
        read: () => readAccountLifecycle({ data: { accountId } }),
        change: (data) => changeAccountLifecycle({ data, headers: { 'X-CSRF-Token': csrfToken ?? '' } }),
      }}
    />
  );
}
