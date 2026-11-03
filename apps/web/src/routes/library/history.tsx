import { createFileRoute } from '@tanstack/react-router';
import { m } from '../../paraglide/messages.js';
import { prepareExposure } from '../../kernel/exposure';
import { pageHead } from '../../shell/head';
import { pageHeadContext } from '../../shell/head-context';
import { requireSignedIn } from '../../session/guard';
import { useSession } from '../../session/query';
import { PrivateDiaryPage } from '../../library/private-diary/page';
import { readPrivateDiary } from '../../library/private-diary/server';

import { diarySearch } from '../../library/private-diary/address';

export const Route = createFileRoute('/library/history')({
  beforeLoad: async (args) => {
    await requireSignedIn(args);
    await prepareExposure(args.context.queryClient);
  },
  validateSearch: diarySearch,
  loaderDeps: ({ search }) => ({ cursor: search.cursor, year: search.year, month: search.month }),
  loader: ({ deps }) => readPrivateDiary({ data: deps }),
  staleTime: 0,
  gcTime: 0,
  head: ({ match }) =>
    pageHead({ title: m.library_diary_heading(), robots: 'noindex, nofollow' }, pageHeadContext(match.pathname)),
  component: function PrivateDiaryRoute() {
    const loaded = Route.useLoaderData();
    const search = Route.useSearch();
    const session = useSession();
    return (
      <PrivateDiaryPage
        key={JSON.stringify([session.subject, session.csrfToken, search])}
        loaded={loaded}
        session={session}
        address={search}
        returnTo={search.returnTo}
      />
    );
  },
});
