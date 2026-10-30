import { createFileRoute } from '@tanstack/react-router';
import { CollectionPublicationPage } from '../../library/collection-publication-page';
import { m } from '../../paraglide/messages.js';
import { requireSignedIn } from '../../session/guard';
import { pageHead } from '../../shell/head';
import { pageHeadContext } from '../../shell/head-context';

export const Route = createFileRoute('/collections/$id/publish')({
  beforeLoad: requireSignedIn,
  validateSearch: (search: Record<string, unknown>): { cursor?: string } => ({
    ...(typeof search.cursor === 'string' && search.cursor.length > 0 && search.cursor.length <= 4096
      ? { cursor: search.cursor }
      : {}),
  }),
  head: ({ match }) =>
    pageHead({ title: m.library_publication_heading(), robots: 'noindex, nofollow' }, pageHeadContext(match.pathname)),
  component: () => <CollectionPublicationPage address={{ id: Route.useParams().id, ...Route.useSearch() }} />,
});
