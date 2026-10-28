import { requireSignedIn } from '../../session/guard';
import { pageHead } from '../../shell/head';
import { pageHeadContext } from '../../shell/head-context';
import { createFileRoute } from '@tanstack/react-router';
import { readMineCollectionsPage } from '../../library/mine-collections-route';
import { MineCollectionsPageView } from '../../library/mine-collections-page';
import { m } from '../../paraglide/messages.js';

export const Route = createFileRoute('/library/collections')({
  beforeLoad: requireSignedIn,
  validateSearch: (search: Record<string, unknown>) =>
    typeof search.cursor === 'string' ? { cursor: search.cursor } : {},
  loaderDeps: ({ search }) => ({ cursor: search.cursor }),
  loader: ({ deps }) => readMineCollectionsPage({ data: { cursor: deps.cursor } }),
  head: ({ match }) =>
    pageHead({ title: m.library_collections_heading(), robots: 'noindex, nofollow' }, pageHeadContext(match.pathname)),
  component: () => <MineCollectionsPageView page={Route.useLoaderData()} />,
});
