import { createFileRoute } from '@tanstack/react-router';
import { useSuspenseQuery } from '@tanstack/react-query';
import { createIsomorphicFn } from '@tanstack/react-start';
import { env } from 'cloudflare:workers';
import { Empty, EmptyHeader, EmptyTitle } from '@rezics/ui/shadcn/empty';
import { SearchPage } from '../search/search.tsx';
import { searchQueryOptions } from '../search/search-queries';
import { searchLoaderDeps, searchParams } from '../search/search-params';
import { PageHeading } from '../shell/page-heading';
import { pageHead } from '../shell/head';
import { validatePublicOrigin } from '../shell/origin';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';

const publicOrigin = createIsomorphicFn()
  .server(() => validatePublicOrigin((env as { PUBLIC_ORIGIN?: string }).PUBLIC_ORIGIN))
  .client(() =>
    validatePublicOrigin(new URL(document.querySelector<HTMLLinkElement>('link[rel="canonical"]')!.href).origin),
  );

export const Route = createFileRoute('/search')({
  validateSearch: searchParams,
  loaderDeps: ({ search }) => searchLoaderDeps(search),
  loader: ({ deps, context }) => {
    const params = {
      query: deps.query,
      type: deps.type,
      facets: deps.facets,
      cursor: deps.cursor,
      sort: deps.sort,
    };
    if (params.query || params.type)
      return context.queryClient
        .ensureQueryData(searchQueryOptions(getLocale(), params))
        .then(() => ({ query: params.query }));
    return { query: params.query };
  },
  head: ({ loaderData }) =>
    pageHead(
      {
        title: loaderData?.query ? `${loaderData.query} – ${m.search_heading()}` : m.search_heading(),
        robots: 'noindex, follow',
      },
      { origin: publicOrigin(), locale: getLocale(), path: '/search' },
    ),
  component: SearchRoute,
  errorComponent: SearchFailed,
});

/** A search the kernel could not answer says so in a sentence, in the page's own frame. */
function SearchFailed() {
  return (
    <section className="mx-auto max-w-5xl space-y-6">
      <PageHeading>{m.search_heading()}</PageHeading>
      <Empty className="border" role="alert">
        <EmptyHeader>
          <EmptyTitle className="text-base font-normal">{m.search_failed()}</EmptyTitle>
        </EmptyHeader>
      </Empty>
    </section>
  );
}

function SearchRoute() {
  const search = Route.useSearch();
  const deps = searchLoaderDeps(search);
  if (!deps.query && !deps.type) return <SearchPage query={deps.query} />;
  return <SearchResults deps={deps} />;
}

function SearchResults({ deps }: { deps: ReturnType<typeof searchLoaderDeps> }) {
  const { data } = useSuspenseQuery(searchQueryOptions(getLocale(), deps));
  return <SearchPage query={deps.query} data={data} />;
}
