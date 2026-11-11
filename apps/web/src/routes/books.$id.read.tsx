import { createFileRoute, useRouter } from '@tanstack/react-router';
import { HostedBookVisitView, parseHostedBookSearch, readHostedBookVisit } from '../books/reader/route';
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

function BookReaderRoute() {
  const visit = Route.useLoaderData();
  const router = useRouter();
  return (
    <HostedBookVisitView
      visit={visit}
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
