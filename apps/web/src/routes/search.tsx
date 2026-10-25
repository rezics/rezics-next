import { createFileRoute } from '@tanstack/react-router';
import { SearchPage, readSearch } from '../search/search.tsx';
import { m } from '../paraglide/messages.js';

export const Route = createFileRoute('/search')({
  validateSearch: (search: Record<string, unknown>) => ({
    q: typeof search.q === 'string' ? search.q : '',
    cursor: typeof search.cursor === 'string' ? search.cursor : undefined,
  }),
  loaderDeps: ({ search }) => ({ query: search.q, cursor: search.cursor }),
  loader: ({ deps }) => (deps.query ? readSearch({ data: { query: deps.query, cursor: deps.cursor } }) : undefined),
  staleTime: 30_000,
  head: () => ({ meta: [{ title: m.search_heading() }] }),
  component: SearchRoute,
});
function SearchRoute() {
  const { q, cursor } = Route.useSearch();
  const result = Route.useLoaderData();
  return <SearchPage query={q} {...(cursor ? { cursor } : {})} {...(result ? { result } : {})} />;
}
