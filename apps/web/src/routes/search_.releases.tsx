import { createFileRoute, useLocation } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import * as v from 'valibot';
import { getLocale } from '../paraglide/runtime.js';
import { useSession } from '../session/query';
import { ReleaseSearchPage } from '../search/release-search-page';
import { releaseSearchQueryOptions } from '../search/release-search-query';

export const Route = createFileRoute('/search_/releases')({
  staticData: { publicCache: false },
  validateSearch: v.objectWithRest({}, v.unknown()),
  loaderDeps: ({ search }) => search,
  loader: ({ deps, context }) =>
    context.queryClient.fetchQuery(releaseSearchQueryOptions(getLocale(), deps, 'unknown')),
  component: ReleaseSearchRoute,
});

function ReleaseSearchRoute() {
  const raw = Route.useSearch();
  const location = useLocation();
  const locale = getLocale();
  const session = useSession();
  const principal = session.state === 'signed-in' ? `signed-in:${session.subject ?? ''}` : session.state;
  const query = useQuery(releaseSearchQueryOptions(locale, raw, principal));
  const result =
    query.isFetching || !query.data ? { ...query.data, state: { status: 'loading' as const } } : query.data;
  return <ReleaseSearchPage key={JSON.stringify(raw)} locale={locale} retryHref={location.href} {...result} />;
}
