import { createFileRoute } from '@tanstack/react-router';
import { readOwnVotesForViewer } from '../../ratings/own-votes/actions';
import { CurrentViewerOwnVotesPage } from '../../ratings/own-votes/page';
import { ownVotesCursor } from '../../ratings/own-votes/inventory';
import { m } from '../../paraglide/messages.js';
import { pageHead } from '../../shell/head';
import { pageHeadContext } from '../../shell/head-context';

export const Route = createFileRoute('/library/ratings')({
  validateSearch: (search: Record<string, unknown>) => {
    const address = ownVotesCursor(search.cursor);
    return {
      ...(address.valid && address.cursor !== null ? { cursor: address.cursor } : {}),
      ...(search.cursor !== undefined && !address.valid ? { invalidCursor: true } : {}),
    };
  },
  loaderDeps: ({ search }) => ({ cursor: search.cursor, invalidCursor: search.invalidCursor === true }),
  loader: ({ deps }) => readOwnVotesForViewer({ data: deps.invalidCursor ? { cursor: '' } : { cursor: deps.cursor } }),
  head: ({ match }) =>
    pageHead({ title: m.library_my_ratings_heading(), robots: 'noindex, nofollow' }, pageHeadContext(match.pathname)),
  component: OwnRatingsRoute,
});

function OwnRatingsRoute() {
  const initial = Route.useLoaderData();
  const search = Route.useSearch();
  const address = ownVotesCursor(search.cursor);
  const invalid = search.invalidCursor === true || !address.valid;
  return (
    <CurrentViewerOwnVotesPage
      initial={initial}
      cursor={invalid ? null : address.cursor}
      invalidAddress={invalid}
    />
  );
}
