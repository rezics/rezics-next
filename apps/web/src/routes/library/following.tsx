import { requireSignedIn } from '../../session/guard';
import { pageHead } from '../../shell/head';
import { pageHeadContext } from '../../shell/head-context';
import { createFileRoute } from '@tanstack/react-router';
import { readMineFollowingForViewer } from '../../library/mine-following-actions';
import { CurrentViewerMineFollowingPage } from '../../library/mine-following-page';
import { m } from '../../paraglide/messages.js';

export const Route = createFileRoute('/library/following')({
  beforeLoad: requireSignedIn,
  validateSearch: (search: Record<string, unknown>) =>
    typeof search.cursor === 'string' ? { cursor: search.cursor } : {},
  loaderDeps: ({ search }) => ({ cursor: search.cursor }),
  loader: ({ deps }) => readMineFollowingForViewer({ data: { cursor: deps.cursor } }),
  head: ({ match }) =>
    pageHead({ title: m.library_following_heading(), robots: 'noindex, nofollow' }, pageHeadContext(match.pathname)),
  component: FollowingRoute,
});

function FollowingRoute() {
  const { cursor } = Route.useSearch();
  return <CurrentViewerMineFollowingPage initial={Route.useLoaderData()} cursor={cursor} />;
}
