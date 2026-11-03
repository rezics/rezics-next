import { createFileRoute } from '@tanstack/react-router';
import { m } from '../../paraglide/messages.js';
import { prepareExposure } from '../../kernel/exposure';
import { pageHead } from '../../shell/head';
import { pageHeadContext } from '../../shell/head-context';
import { requireSignedIn } from '../../session/guard';
import { useSession } from '../../session/query';
import { PrivateDiaryPage } from '../../library/private-diary/page';
import { readPrivateDiary } from '../../library/private-diary/server';

function diarySearch(search: Record<string, unknown>) {
  const cursor = typeof search.cursor === 'string' && search.cursor.length <= 4096 ? search.cursor : undefined;
  const returnTo = typeof search.returnTo === 'string' && search.returnTo.length <= 2048 ? search.returnTo : undefined;
  return { ...(cursor ? { cursor } : {}), ...(returnTo ? { returnTo } : {}) };
}

export const Route = createFileRoute('/library/history')({
  beforeLoad: async (args) => {
    await requireSignedIn(args);
    await prepareExposure(args.context.queryClient);
  },
  validateSearch: diarySearch,
  loaderDeps: ({ search }) => ({ cursor: search.cursor }),
  loader: ({ deps }) => readPrivateDiary({ data: { cursor: deps.cursor } }),
  staleTime: 0,
  gcTime: 0,
  head: ({ match }) => pageHead({ title: m.library_diary_heading(), robots: 'noindex, nofollow' }, pageHeadContext(match.pathname)),
  component: function PrivateDiaryRoute() {
    const loaded = Route.useLoaderData();
    const search = Route.useSearch();
    const session = useSession();
    return <PrivateDiaryPage loaded={loaded} session={session} returnTo={search.returnTo} />;
  },
});
