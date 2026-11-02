import { requireSignedIn } from '../../session/guard';
import { pageHead } from '../../shell/head';
import { pageHeadContext } from '../../shell/head-context';
import { createFileRoute, useLocation } from '@tanstack/react-router';
import { readMineFollowingForViewer } from '../../library/mine-following-actions';
import { CurrentViewerMineFollowingPage } from '../../library/mine-following-page';
import { PERSONAL_DIRECTORY_CURSOR_LIMITS, personalDirectoryAddress } from '../../library/personal-directory-address';
import { m } from '../../paraglide/messages.js';

export const Route = createFileRoute('/library/following')({
  beforeLoad: requireSignedIn,
  validateSearch: (search: Record<string, unknown>) =>
    search.cursor === undefined ? {} : { cursor: search.cursor as string },
  loaderDeps: ({ search }) => ({ cursor: search.cursor }),
  loader: ({ deps }) => readMineFollowingForViewer({ data: { cursor: deps.cursor } }),
  head: ({ match }) =>
    pageHead({ title: m.library_following_heading(), robots: 'noindex, nofollow' }, pageHeadContext(match.pathname)),
  component: FollowingRoute,
});

function FollowingRoute() {
  const initial = Route.useLoaderData();
  // The active match can retain its old search while the next loader is pending.
  const location = useLocation();
  const address = personalDirectoryAddress(location.search.cursor, PERSONAL_DIRECTORY_CURSOR_LIMITS.following);
  if (location.pathname.replace(/\/$/, '') !== '/library/following') return null;
  return (
    <CurrentViewerMineFollowingPage
      initial={initial}
      {...(address.cursor !== null ? { cursor: address.cursor } : {})}
      invalidAddress={!address.valid}
    />
  );
}
