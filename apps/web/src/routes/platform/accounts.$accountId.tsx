import { Outlet, useRouterState, createFileRoute } from '@tanstack/react-router';
import { changeAccountLifecycle, readAccountLifecycle } from '../../accounts/lifecycle-controls/actions';
import { reviewRequest } from '../../accounts/lifecycle-controls/request';
import { AccountLifecyclePage } from '../../accounts/lifecycle-controls/page';
import { m } from '../../paraglide/messages.js';
import { requireSignedIn } from '../../session/guard';
import { useSession } from '../../session/query';
import { pageHead } from '../../shell/head';
import { pageHeadContext } from '../../shell/head-context';

export const Route = createFileRoute('/platform/accounts/$accountId')({
  beforeLoad: requireSignedIn,
  loader: ({ params, location, abortController }) =>
    /\/erasure\/?$/.test(location.pathname)
      ? null
      : reviewRequest(
          (signal) => readAccountLifecycle({ data: { accountId: params.accountId }, signal }),
          abortController.signal,
        ),
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
        read: (signal) => readAccountLifecycle({ data: { accountId }, signal }),
        change: (data, signal) =>
          changeAccountLifecycle({ data, signal, headers: { 'X-CSRF-Token': csrfToken ?? '' } }),
      }}
    />
  );
}
