import { createFileRoute, useRouter } from '@tanstack/react-router';
import { useRef, useState } from 'react';
import { requireSignedIn } from '../../session/guard';
import { pageHead } from '../../shell/head';
import { pageHeadContext } from '../../shell/head-context';
import { m } from '../../paraglide/messages.js';
import { readDecisionPage } from '../../moderation/decision-read';
import { DecisionPageView, DecisionReadStatus } from '../../moderation/decision-page';
import { decisionReadFailure } from '../../moderation/decision-read-model';

export const Route = createFileRoute('/moderation/decisions/$id')({
  beforeLoad: requireSignedIn,
  loader: async ({ params, abortController }) => {
    const page = await readDecisionPage({ data: { id: params.id } });
    abortController.signal.throwIfAborted();
    return page;
  },
  staleTime: 0,
  gcTime: 0,
  pendingMs: 0,
  pendingMinMs: 0,
  head: ({ match }) =>
    pageHead({ title: m.decision_heading(), robots: 'noindex, nofollow' }, pageHeadContext(match.pathname)),
  component: DecisionRoute,
  pendingComponent: () => <DecisionReadStatus state="loading" />,
  notFoundComponent: () => <DecisionReadStatus state="closed" />,
  errorComponent: DecisionRouteError,
});

function DecisionRoute() {
  return <DecisionPageView page={Route.useLoaderData()} />;
}

function DecisionRouteError({ error }: { error: unknown }) {
  const router = useRouter();
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  async function retry() {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    try {
      await router.invalidate({ sync: true });
    } catch {
      // The current loader error owns the next safe recovery state.
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  return <DecisionReadStatus state={decisionReadFailure(error)} busy={busy} onRetry={() => void retry()} />;
}
