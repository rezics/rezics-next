import { createFileRoute, useRouter, useRouterState } from '@tanstack/react-router';
import { m } from '../../paraglide/messages.js';
import { readExactRevision } from '../../threads/exact-revision-read';
import { ExactRevisionView } from '../../threads/exact-revision-view';
import { EditionCreateEntry } from '../../content-editions/edition-create-entry';

export const Route = createFileRoute('/posts/$id/revisions/$revisionId')({
  staticData: { sessionReread: true },
  // Immutable bytes still need fresh current disclosure on every entry and retry.
  staleTime: 0,
  gcTime: 0,
  shouldReload: true,
  pendingMs: 0,
  loader: ({ params, context }) =>
    readExactRevision({
      data: { postId: params.id, revisionId: params.revisionId, credentialMode: context.credentialMode },
    }),
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
  const page = Route.useLoaderData();
  const router = useRouter();
  const loading = useRouterState({ select: (state) => state.isLoading });
  return (
    <>
      <ExactRevisionView
        identity={{ postId: params.id, revisionId: params.revisionId }}
        page={loading ? { state: 'loading' } : page}
        onRetry={() => {
          void router.invalidate();
        }}
      />
      {!loading && page.state === 'ready' ? (
        <EditionCreateEntry identity={{ postId: params.id, revisionId: params.revisionId }} />
      ) : null}
    </>
  );
}
