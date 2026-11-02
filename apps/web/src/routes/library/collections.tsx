import { requireSignedIn } from '../../session/guard';
import { pageHead } from '../../shell/head';
import { pageHeadContext } from '../../shell/head-context';
import { createFileRoute, useLocation } from '@tanstack/react-router';
import { readMineCollectionsViewerPage } from '../../library/mine-collections-route';
import { MineCollectionsCurrentViewer } from '../../library/mine-collections-page';
import { admitMineCollectionsAddress } from '../../library/mine-collections-address';
import { m } from '../../paraglide/messages.js';

export const Route = createFileRoute('/library/collections')({
  beforeLoad: requireSignedIn,
  validateSearch: admitMineCollectionsAddress,
  loaderDeps: ({ search }) => search,
  loader: ({ deps }) => readMineCollectionsViewerPage({ data: deps }),
  head: ({ match }) =>
    pageHead({ title: m.library_collections_heading(), robots: 'noindex, nofollow' }, pageHeadContext(match.pathname)),
  component: () => {
    const initial = Route.useLoaderData();
    // The current location changes before the active match's search while a loader is pending.
    const location = useLocation();
    if (location.pathname.replace(/\/$/, '') !== '/library/collections') return null;
    const search = admitMineCollectionsAddress(location.search);
    return (
      <MineCollectionsCurrentViewer
        initial={initial}
        layout={search.layout}
        {...(search.addressError ? { addressError: search.addressError } : {})}
        {...(search.cursor ? { cursor: search.cursor } : {})}
      />
    );
  },
});
