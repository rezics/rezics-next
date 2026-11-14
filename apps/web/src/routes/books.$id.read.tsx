import { createFileRoute, useRouter } from '@tanstack/react-router';
import {
  HostedBookVisitView,
  hostedBookNavigationForRouter,
  parseHostedBookSearch,
  readHostedBookVisit,
} from '../books/reader/route';
import { QueryClientContext } from '@tanstack/react-query';
import { useContext } from 'react';
import { getLocale } from '../paraglide/runtime.js';
import { m } from '../paraglide/messages.js';
import { pageHead } from '../shell/head';
import { pageHeadContext } from '../shell/head-context';

/** The router's locale rewrite exposes /{locale}/books/{id}/read. Search values select native reads only. */
export const Route = createFileRoute('/books/$id/read')({
  staticData: { sessionReread: true },
  validateSearch: parseHostedBookSearch,
  staleTime: 0,
  gcTime: 0,
  shouldReload: true,
  pendingMs: 0,
  loaderDeps: ({ search }) => search,
  loader: ({ params, deps }) =>
    readHostedBookVisit({
      data: { catalogueId: params.id, locale: getLocale(), search: deps },
    }),
  head: ({ match }) =>
    pageHead({ title: m.book_reader_title(), robots: 'noindex, follow' }, pageHeadContext(match.pathname)),
  pendingComponent: BookReaderPending,
  component: BookReaderRoute,
});

function BookReaderPending() {
  const search = Route.useSearch();
  const contents = search.view === 'contents' || (search.view === undefined && !search.occurrence);
  return (
    <main aria-busy="true" className="mx-auto grid max-w-3xl gap-4 px-4 py-8">
      <h1 className="text-2xl font-semibold">{contents ? m.book_reader_contents() : m.book_reader_title()}</h1>
      <p role="status">{m.book_reader_loading()}</p>
      {contents ? <p className="text-sm text-muted-foreground">{m.book_reader_contents_recovery()}</p> : null}
    </main>
  );
}

function BookReaderRoute() {
  const visit = Route.useLoaderData();
  const router = useRouter();
  const { id } = Route.useParams();
  const search = Route.useSearch();
  const client = useContext(QueryClientContext);
  const navigation = hostedBookNavigationForRouter(router, client);
  return (
    <HostedBookVisitView
      visit={visit}
      navigation={navigation}
      location={{ catalogueId: id, search }}
      locale={getLocale()}
      navigate={(href) => {
        void router.navigate({ href });
      }}
      reload={() => {
        void router.invalidate();
      }}
    />
  );
}
