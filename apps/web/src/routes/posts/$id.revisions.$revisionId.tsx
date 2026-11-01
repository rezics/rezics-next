import { createFileRoute, useRouter, useRouterState } from '@tanstack/react-router';
import { m } from '../../paraglide/messages.js';
import { readExactRevision } from '../../threads/exact-revision-read';
import { ExactRevisionView } from '../../threads/exact-revision-view';
import { ExactRevisionCaller, readExactRevisionVisit } from '../../threads/exact-revision-caller';
import { getLocale } from '../../paraglide/runtime.js';

export const Route = createFileRoute('/posts/$id/revisions/$revisionId')({
  staticData: { sessionReread: true },
  // Immutable bytes still need fresh current disclosure on every entry and retry.
  staleTime: 0,
  gcTime: 0,
  shouldReload: true,
  pendingMs: 0,
  loader: ({ params, context }) => {
    const identity = { postId: params.id, revisionId: params.revisionId };
    const locale = getLocale();
    const credentialMode = context.credentialMode;
    return readExactRevisionVisit(context.queryClient, identity, locale, credentialMode, () =>
      readExactRevision({ data: { ...identity, credentialMode } }),
    );
  },
  head: () => ({ meta: [{ title: m.exact_revision_heading() }, { name: 'robots', content: 'noindex, follow' }] }),
  pendingComponent: ExactRevisionPending,
  component: ExactRevisionPage,
});

function ExactRevisionPending() {
  const params = Route.useParams();
  return (
    <ExactRevisionView identity={{ postId: params.id, revisionId: params.revisionId }} page={{ state: 'loading' }} />
  );
}

function ExactRevisionPage() {
  const params = Route.useParams();
  const visit = Route.useLoaderData();
  const router = useRouter();
  const { credentialMode } = Route.useRouteContext();
  const loading = useRouterState({ select: (state) => state.isLoading });
  const locale = getLocale();
  return (
    <ExactRevisionCaller
      visit={visit}
      identity={{ postId: params.id, revisionId: params.revisionId }}
      locale={locale}
      credentialMode={credentialMode}
      loading={loading}
      onRetry={() => void router.invalidate()}
    />
  );
}
