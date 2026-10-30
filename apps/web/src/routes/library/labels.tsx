import { createFileRoute } from '@tanstack/react-router';
import { pageHead } from '../../shell/head';
import { pageHeadContext } from '../../shell/head-context';
import { readLabelsPage } from '../../library/labels-read-route';
import { LabelsPageView } from '../../library/labels-page';
import { labelsFormPost } from '../../library/labels-actions';
import { m } from '../../paraglide/messages.js';

export const Route = createFileRoute('/library/labels')({
  server: { handlers: { POST: labelsFormPost } },
  validateSearch: (search: Record<string, unknown>) => ({
    ...(typeof search.cursor === 'string' ? { cursor: search.cursor } : {}),
    ...(typeof search.q === 'string' ? { q: search.q } : {}),
  }),
  loaderDeps: ({ search }) => ({ cursor: search.cursor, query: search.q }),
  loader: ({ deps }) => readLabelsPage({ data: { cursor: deps.cursor, query: deps.query } }),
  head: ({ match }) =>
    pageHead({ title: m.library_labels_heading(), robots: 'noindex, nofollow' }, pageHeadContext(match.pathname)),
  component: () => <LabelsPageView page={Route.useLoaderData()} />,
});
