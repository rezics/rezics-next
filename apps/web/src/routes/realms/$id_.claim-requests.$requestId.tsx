import { createFileRoute } from '@tanstack/react-router';
import { RealmClaimStatusPanel } from '../../community/realm-claim-status-panel';
import { requireSignedIn } from '../../session/guard';
import { pageHead } from '../../shell/head';
import { pageHeadContext } from '../../shell/head-context';
import { m } from '../../paraglide/messages.js';

export const Route = createFileRoute('/realms/$id_/claim-requests/$requestId')({
  beforeLoad: requireSignedIn,
  head: ({ match }) =>
    pageHead({ title: m.realm_claim_status_heading(), robots: 'noindex, nofollow' }, pageHeadContext(match.pathname)),
  component: ClaimStatusRoute,
});

function ClaimStatusRoute() {
  const { id, requestId } = Route.useParams();
  return <RealmClaimStatusPanel realmId={id} requestId={requestId} />;
}
