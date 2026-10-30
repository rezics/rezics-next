import { createFileRoute } from '@tanstack/react-router';
import { readRealmClaimReviewPage } from '../../community/realm-claim-review-actions';
import { RealmClaimReviewPanel } from '../../community/realm-claim-review-panel';
import { requireSignedIn } from '../../session/guard';
import { pageHead } from '../../shell/head';
import { pageHeadContext } from '../../shell/head-context';
import { m } from '../../paraglide/messages.js';

export const Route = createFileRoute('/realms/$id_/claims')({
  beforeLoad: requireSignedIn,
  loader: ({ params }) => readRealmClaimReviewPage({ data: { realmId: params.id } }),
  head: ({ match }) =>
    pageHead({ title: m.realm_review_heading(), robots: 'noindex, nofollow' }, pageHeadContext(match.pathname)),
  component: ClaimReviewRoute,
});

function ClaimReviewRoute() {
  return <RealmClaimReviewPanel realmId={Route.useParams().id} initial={Route.useLoaderData()} />;
}
