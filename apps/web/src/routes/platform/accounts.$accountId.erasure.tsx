import { createFileRoute } from '@tanstack/react-router';
import { AccountErasurePage } from '../../accounts/erasure-progress/page';
import { m } from '../../paraglide/messages.js';
import { requireSignedIn } from '../../session/guard';
import { pageHead } from '../../shell/head';
import { pageHeadContext } from '../../shell/head-context';

export const Route = createFileRoute('/platform/accounts/$accountId/erasure')({
  beforeLoad: requireSignedIn,
  head: ({ match }) =>
    pageHead({ title: m.erasure_title(), robots: 'noindex, nofollow' }, pageHeadContext(match.pathname)),
  component: ErasureRoute,
});
function ErasureRoute() {
  const { accountId } = Route.useParams();
  return <AccountErasurePage key={accountId} accountId={accountId} />;
}
