import { createFileRoute } from '@tanstack/react-router';
import { AccountVerificationJourney } from '../../account-verification/journeys';
import { requireSignedIn } from '../../session/guard';
import { pageHead } from '../../shell/head';
import { pageHeadContext } from '../../shell/head-context';
import { m } from '../../paraglide/messages.js';

export const Route = createFileRoute('/accounts/$accountId/verification')({
  beforeLoad: requireSignedIn,
  head: ({ match }) =>
    pageHead({ title: m.av_status_title(), robots: 'noindex, nofollow' }, pageHeadContext(match.pathname)),
  component: AccountVerificationRoute,
});
function AccountVerificationRoute() {
  return <AccountVerificationJourney accountId={Route.useParams().accountId} />;
}
