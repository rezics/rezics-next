import { createFileRoute } from '@tanstack/react-router';
import { BookCataloguePage } from '../books/catalogue/page';
import { loadBookCatalogue } from '../books/catalogue/server';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';

export const Route = createFileRoute('/books')({
  staticData: { publicCache: true },
  loader: () => loadBookCatalogue(),
  head: ({ loaderData }) => ({
    meta: [{ title: m.books_catalogue_title({}, { locale: loaderData?.locale ?? getLocale() }) }],
  }),
  component: () => <BookCataloguePage {...Route.useLoaderData()} />,
});
