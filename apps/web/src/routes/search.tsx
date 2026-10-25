import { createFileRoute } from '@tanstack/react-router';
import { FILTER_LIMITS } from '@rezics/filter';
import { SearchPage, readSearch } from '../search/search.tsx';
import { m } from '../paraglide/messages.js';

function facetValuesFromSearch(search: Record<string, unknown>): Record<string, string[]> {
  const facets: Record<string, string[]> = Object.create(null);
  for (const [key, value] of Object.entries(search)) {
    if (!key.startsWith('f.') || key.length <= 2) continue;
    const property = key.slice(2);
    if (typeof value === 'string') facets[property] = [value];
    else if (Array.isArray(value))
      facets[property] = value.slice(0, FILTER_LIMITS.in).filter((item): item is string => typeof item === 'string');
  }
  return facets;
}

export const Route = createFileRoute('/search')({
  validateSearch: (search: Record<string, unknown>) => {
    const validated: Record<string, unknown> = {};
    if (Object.hasOwn(search, 'q') && typeof search.q === 'string' && search.q.length <= 256) validated.q = search.q;
    if (typeof search.type === 'string' && search.type.length <= 128) validated.type = search.type;
    if (typeof search.cursor === 'string' && search.cursor.length <= 2048) validated.cursor = search.cursor;
    for (const [key, value] of Object.entries(search)) {
      if (!key.startsWith('f.') || key.length <= 2) continue;
      if (typeof value === 'string') validated[key] = value;
      else if (Array.isArray(value))
        validated[key] = value.slice(0, FILTER_LIMITS.in).filter((item): item is string => typeof item === 'string');
    }
    return validated;
  },
  loaderDeps: ({ search }) => ({
    query: typeof search.q === 'string' ? search.q : '',
    type: typeof search.type === 'string' ? search.type : undefined,
    facets: facetValuesFromSearch(search),
    cursor: typeof search.cursor === 'string' ? search.cursor : undefined,
  }),
  loader: ({ deps }) =>
    deps.query || deps.type
      ? readSearch({
          data: {
            query: deps.query,
            ...(deps.type ? { type: deps.type } : {}),
            facetValues: deps.facets,
            ...(deps.cursor ? { cursor: deps.cursor } : {}),
          },
        })
      : undefined,
  staleTime: 30_000,
  head: () => ({ meta: [{ title: m.search_heading() }] }),
  component: SearchRoute,
});

function SearchRoute() {
  const search = Route.useSearch();
  const q = typeof search.q === 'string' ? search.q : '';
  const cursor = typeof search.cursor === 'string' ? search.cursor : undefined;
  const data = Route.useLoaderData();
  return <SearchPage query={q} {...(cursor ? { cursor } : {})} {...(data ? { data } : {})} />;
}
