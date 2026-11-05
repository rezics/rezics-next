import { createFileRoute, useRouter } from '@tanstack/react-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { requireSignedIn } from '../../session/guard';
import { pageHead } from '../../shell/head';
import { pageHeadContext } from '../../shell/head-context';
import { m } from '../../paraglide/messages.js';
import { readDecisionPage } from '../../moderation/decision-read';
import { DecisionPageView, DecisionReadStatus } from '../../moderation/decision-page';
import { decisionReadFailure, prepareDecisionRead } from '../../moderation/decision-read-model';

export const Route = createFileRoute('/moderation/decisions/$id')({
  beforeLoad: requireSignedIn,
  loader: async ({ params, context, abortController, location }) => {
    const page = await prepareDecisionRead(
      context.queryClient,
      params.id,
      (id) => readDecisionPage({ data: { id } }),
      abortController.signal,
    );
    return { ...page, navigationKey: location.state.__TSR_key ?? location.href };
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
  const page = Route.useLoaderData();
  const router = useRouter();
  const navigation = useMemo(
    () => ({
      isCurrent: () => (router.state.location.state.__TSR_key ?? router.state.location.href) === page.navigationKey,
      subscribe: (retire: () => void) => {
        const leave = router.subscribe('onBeforeNavigate', ({ toLocation }) => {
          if ((toLocation.state.__TSR_key ?? toLocation.href) !== page.navigationKey) retire();
        });
        const reload = router.subscribe('onBeforeLoad', retire);
        return () => {
          leave();
          reload();
        };
      },
    }),
    [router, page.navigationKey, page.readGeneration],
  );
  return <DecisionPageView page={page} navigation={navigation} />;
}

function DecisionRouteError({ error }: { error: unknown }) {
  const router = useRouter();
  const connection = useRef({ active: true, location: router.state.location });
  useEffect(() => {
    connection.current.active = true;
    return () => {
      connection.current.active = false;
    };
  }, []);
  const current = () => connection.current.active && connection.current.location === router.state.location;
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  async function retry() {
    if (!current() || pending.current) return;
    pending.current = true;
    setBusy(true);
    try {
      await router.invalidate({ sync: true });
    } catch {
      // The current loader error owns the next safe recovery state.
    } finally {
      if (current()) {
        pending.current = false;
        setBusy(false);
      }
    }
  }
  return <DecisionReadStatus state={decisionReadFailure(error)} busy={busy} onRetry={() => void retry()} />;
}
