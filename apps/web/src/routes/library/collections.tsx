import { requireSignedIn } from '../../session/guard';
import { pageHead } from '../../shell/head';
import { pageHeadContext } from '../../shell/head-context';
import { createFileRoute } from '@tanstack/react-router';
import { readMineCollectionsViewerPage } from '../../library/mine-collections-route';
import { MineCollectionsCurrentViewer } from '../../library/mine-collections-page';
import { m } from '../../paraglide/messages.js';

export const Route = createFileRoute('/library/collections')({
  beforeLoad: requireSignedIn,
  validateSearch: (search: Record<string, unknown>) => ({
    ...(typeof search.cursor === 'string' && search.cursor.length <= 4096 ? { cursor: search.cursor } : {}),
    layout: search.layout === 'previews' ? ('previews' as const) : ('rows' as const),
  }),
  loaderDeps: ({ search }) => ({ cursor: search.cursor, layout: search.layout }),
  loader: ({ deps }) => readMineCollectionsViewerPage({ data: { cursor: deps.cursor, layout: deps.layout } }),
  head: ({ match }) =>
    pageHead({ title: m.library_collections_heading(), robots: 'noindex, nofollow' }, pageHeadContext(match.pathname)),
  component: () => {
    const initial = Route.useLoaderData();
    const search = Route.useSearch();
    return (
      <MineCollectionsCurrentViewer
        initial={initial}
        layout={search.layout}
        {...(search.cursor ? { cursor: search.cursor } : {})}
      />
    );
  },
});
