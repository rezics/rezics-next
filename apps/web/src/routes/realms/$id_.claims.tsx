import { createFileRoute } from '@tanstack/react-router';
import { readRealmClaimReviewPage } from '../../community/realm-claim-review-actions';
import { RealmClaimReviewPanel } from '../../community/realm-claim-review-panel';
import { requireSignedIn } from '../../session/guard';
import { sessionQuery } from '../../session/query';
import { realmClaimCallerSessionSource } from '../../community/realm-claim-caller-lifetime';
import { pageHead } from '../../shell/head';
import { pageHeadContext } from '../../shell/head-context';
import { m } from '../../paraglide/messages.js';

export const Route = createFileRoute('/realms/$id_/claims')({
  beforeLoad: requireSignedIn,
  loader: async ({ params, context }) => {
    const queryKey = sessionQuery.queryKey;
    const beforeState = context.queryClient.getQueryState(queryKey);
    const before = beforeState?.dataUpdateCount;
    const sourceId = typeof window === 'undefined' ? undefined : realmClaimCallerSessionSource(context.queryClient).id;
    const subject = context.queryClient.getQueryData<{ subject?: string | null }>(queryKey)?.subject ?? undefined;
    const read = await readRealmClaimReviewPage({ data: { realmId: params.id } });
    const afterState = context.queryClient.getQueryState(queryKey);
    const after = afterState?.dataUpdateCount;
    const afterSubject = context.queryClient.getQueryData<{ subject?: string | null }>(queryKey)?.subject ?? undefined;
    const sessionStable =
      before !== undefined &&
      before === after &&
      beforeState?.dataUpdatedAt === afterState?.dataUpdatedAt &&
      typeof subject === 'string' &&
      subject === afterSubject;
    return {
      ...read,
      callerRealmId: params.id,
      callerSessionSourceId: sourceId,
      callerSessionSubject: sessionStable ? subject : undefined,
      // Query state markers survive hydration without copying a CSRF credential into loader data.
      callerSessionDataUpdateCount: sessionStable ? before : -1,
      callerSessionDataUpdatedAt: sessionStable ? beforeState!.dataUpdatedAt : -1,
    };
  },
  head: ({ match }) =>
    pageHead({ title: m.realm_review_heading(), robots: 'noindex, nofollow' }, pageHeadContext(match.pathname)),
  component: ClaimReviewRoute,
});

function ClaimReviewRoute() {
  return <RealmClaimReviewPanel realmId={Route.useParams().id} initial={Route.useLoaderData()} />;
}
