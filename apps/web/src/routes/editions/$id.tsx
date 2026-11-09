import { createFileRoute, useParams } from '@tanstack/react-router';
import { readContentEdition } from '../../content-editions/edition-read';
import { ContentEditionPage } from '../../content-editions/edition-view';
import { m } from '../../paraglide/messages.js';
import { pageHead } from '../../shell/head';
import { pageHeadContext } from '../../shell/head-context';
import { EditionRoute } from '../../content-editions/edition-route';

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
