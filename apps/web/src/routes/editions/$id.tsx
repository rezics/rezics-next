import { createFileRoute, useLoaderData, useParams, useRouter, useRouterState } from '@tanstack/react-router';
import { readContentEdition } from '../../content-editions/edition-read';
import { ContentEditionPage } from '../../content-editions/edition-view';
import { m } from '../../paraglide/messages.js';
import { pageHead } from '../../shell/head';
import { pageHeadContext } from '../../shell/head-context';

export const Route = createFileRoute('/editions/$id')({
  staleTime: 0,
  gcTime: 0,
  shouldReload: true,
  pendingMs: 0,
  loader: ({ params }) => readContentEdition({ data: { editionId: params.id } }),
  head: ({ match }) =>
    pageHead({ title: m.content_edition_heading(), robots: 'noindex, nofollow' }, pageHeadContext(match.pathname)),
  pendingComponent: () => <ContentEditionPage editionId={Route.useParams().id} page={{ state: 'loading' }} />,
  component: EditionRoute,
});

export function EditionRoute() {
  const editionId = useParams({ from: '/editions/$id' }).id;
  const page = useLoaderData({ from: '/editions/$id' });
  const router = useRouter();
  const loading = useRouterState({ select: (state) => state.isLoading });
  // Retain current refusals during a reread, but conceal old bytes during fresh authorization.
  return (
    <ContentEditionPage
      editionId={editionId}
      page={loading && page.state === 'published' ? { state: 'loading' } : page}
      retrying={loading}
      onRetry={() => {
        void router.invalidate();
      }}
    />
  );
}
