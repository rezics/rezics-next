import { createFileRoute } from '@tanstack/react-router';
import { readMineFollowingPage } from '../../library/mine-following-actions';
import { MineFollowingPageView } from '../../library/mine-following-page';
import { m } from '../../paraglide/messages.js';

export const Route = createFileRoute('/library/following')({
  validateSearch: (search: Record<string, unknown>) =>
    typeof search.cursor === 'string' ? { cursor: search.cursor } : {},
  loaderDeps: ({ search }) => ({ cursor: search.cursor }),
  loader: ({ deps }) => readMineFollowingPage({ data: { cursor: deps.cursor } }),
  head: () => ({ meta: [{ title: m.library_following_heading() }] }),
  component: () => <MineFollowingPageView page={Route.useLoaderData()} />,
});
