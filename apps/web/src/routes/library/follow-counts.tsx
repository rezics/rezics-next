import { createFileRoute } from '@tanstack/react-router';
import { followCountsSearch } from '../../library/private-follow-counts';
import { PrivateFollowCountsPage } from '../../library/private-follow-counts-page';
import { m } from '../../paraglide/messages.js';
import { requireSignedIn } from '../../session/guard';
import { pageHead } from '../../shell/head';
import { pageHeadContext } from '../../shell/head-context';

export const Route = createFileRoute('/library/follow-counts')({
  beforeLoad: requireSignedIn,
  validateSearch: followCountsSearch,
  head: ({ match }) =>
    pageHead(
      { title: m.library_follow_counts_heading(), robots: 'noindex, nofollow' },
      pageHeadContext(match.pathname),
    ),
  component: () => <PrivateFollowCountsPage context={Route.useSearch()} />,
});
