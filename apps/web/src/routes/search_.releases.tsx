import { createFileRoute, useLocation } from '@tanstack/react-router';
import * as v from 'valibot';
import { getLocale } from '../paraglide/runtime.js';
import { ReleaseSearchPage, releaseSearchQueryOptions, useReleaseWindowQuery } from '../search/release-window';

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
  const { result, reader } = useReleaseWindowQuery(locale, raw);
  return <ReleaseSearchPage reader={reader} locale={locale} retryHref={location.href} {...result} />;
}
