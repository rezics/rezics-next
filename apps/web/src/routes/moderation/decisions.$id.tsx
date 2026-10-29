import { createFileRoute } from '@tanstack/react-router';
import { requireSignedIn } from '../../session/guard';
import { pageHead } from '../../shell/head';
import { pageHeadContext } from '../../shell/head-context';
import { m } from '../../paraglide/messages.js';
import { readDecisionPage } from '../../moderation/decision-read';
import { DecisionPageView } from '../../moderation/decision-page';

export const Route = createFileRoute('/moderation/decisions/$id')({
  beforeLoad: requireSignedIn,
  loader: ({ params }) => readDecisionPage({ data: { id: params.id } }),
  head: ({ match }) =>
    pageHead({ title: m.decision_heading(), robots: 'noindex, nofollow' }, pageHeadContext(match.pathname)),
  component: DecisionRoute,
});

function DecisionRoute() {
  return <DecisionPageView page={Route.useLoaderData()} />;
}
