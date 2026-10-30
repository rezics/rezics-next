import { requireSignedIn } from '../../session/guard';
import { pageHead } from '../../shell/head';
import { pageHeadContext } from '../../shell/head-context';
import { createFileRoute } from '@tanstack/react-router';
import { readMineCollectionsPage } from '../../library/mine-collections-route';
import { MineCollectionsPageView } from '../../library/mine-collections-page';
import { m } from '../../paraglide/messages.js';
import { readLibraryPinsPage } from '../../library/pins-read';

export const Route = createFileRoute('/library/collections')({
  beforeLoad: requireSignedIn,
  validateSearch: (search: Record<string, unknown>) => ({
    ...(typeof search.cursor === 'string' && search.cursor.length <= 4096 ? { cursor: search.cursor } : {}),
    layout: search.layout === 'previews' ? ('previews' as const) : ('rows' as const),
  }),
  loaderDeps: ({ search }) => ({ cursor: search.cursor, layout: search.layout }),
  loader: async ({ deps }) => {
    const [page, pins] = await Promise.all([
      readMineCollectionsPage({ data: { cursor: deps.cursor, layout: deps.layout } }),
      readLibraryPinsPage({ data: 100 }),
    ]);
    return { page, pins };
  },
  head: ({ match }) =>
    pageHead({ title: m.library_collections_heading(), robots: 'noindex, nofollow' }, pageHeadContext(match.pathname)),
  component: () => {
    const { page, pins } = Route.useLoaderData();
    const search = Route.useSearch();
    return (
      <MineCollectionsPageView
        page={page}
        pins={pins}
        layout={search.layout}
        {...(search.cursor ? { cursor: search.cursor } : {})}
      />
    );
  },
});
