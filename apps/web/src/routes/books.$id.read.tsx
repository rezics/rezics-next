import { createFileRoute, useRouter } from '@tanstack/react-router';
import { HostedBookVisitView, createHostedBookNavigation, parseHostedBookSearch, readHostedBookVisit } from '../books/reader/route';
import { QueryClientContext } from '@tanstack/react-query';
import { useContext } from 'react';
import { readerSessionSource } from '../reader/lifetime';
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
  pendingComponent: () => (
    <main aria-busy="true" className="mx-auto max-w-3xl px-4 py-8">
      <p role="status">{m.book_reader_loading()}</p>
    </main>
  ),
  component: BookReaderRoute,
});

// A WeakMap keeps one bounded visit per live Router across loader/pending component remounts.
// It is not history payload: direct entry/reload starts empty, and Back/Forward still rereads the URL.
const contentsVisits = new WeakMap<object, ReturnType<typeof createHostedBookNavigation>>();

function BookReaderRoute() {
  const visit = Route.useLoaderData();
  const router = useRouter();
  const client = useContext(QueryClientContext);
  let navigation = contentsVisits.get(router);
  if (!navigation) {
    navigation = createHostedBookNavigation();
    contentsVisits.set(router, navigation);
    const owned = navigation;
    const path = router.state.location.pathname;
    const stopSession = readerSessionSource(client).subscribe(() => owned.retire());
    window.addEventListener('pagehide', owned.retire);
    const stopRoute = router.subscribe('onBeforeLoad', ({ toLocation }) => {
      if (toLocation.pathname === path) return;
      owned.retire();
      contentsVisits.delete(router);
      stopSession();
      window.removeEventListener('pagehide', owned.retire);
      stopRoute();
    });
  }
  return (
    <HostedBookVisitView
      visit={visit}
      navigation={navigation}
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
