import { followingKind } from '../../library/following-kind-navigation/address';
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
  validateSearch: (search: Record<string, unknown>) => ({
    ...(search.cursor === undefined ? {} : { cursor: search.cursor as string }),
    ...(search.kind === undefined ? {} : { kind: typeof search.kind === 'string' ? search.kind : 'invalid' }),
  }),
  loaderDeps: ({ search }) => ({ cursor: search.cursor, kind: search.kind }),
  loader: async ({ deps }) => {
    const read = await readMineFollowingForViewer({ data: { cursor: deps.cursor, kind: deps.kind } });
    if (typeof document !== 'undefined' || !read.page.follows.some((row) => !row.target)) return read;
    // The document may show unavailable rows. Only a current private read supplies their command operands.
    return {
      ...read,
      documentPreview: true as const,
      page: {
        ...read.page,
        follows: read.page.follows.map((row) =>
          row.target
            ? row
            : {
                target: null,
                targetId: '',
                targetType: row.targetType,
                state: row.state,
                reason: row.reason,
                idempotencyKey: row.idempotencyKey,
              },
        ),
      },
    };
  },
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
      kind={followingKind(location.search.kind) ?? 'all'}
      invalidAddress={!address.valid || !followingKind(location.search.kind)}
    />
  );
}
