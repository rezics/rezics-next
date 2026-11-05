import { createFileRoute, useLocation } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useSyncExternalStore } from 'react';
import { browserObservation } from '../session';
import { useReaderAddress, useReaderResponseOrigin, type ReaderOrigin } from '../session/reader';
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
  const client = useQueryClient();
  const store = browserObservation(client);
  const observation = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot);
  const readerKey = JSON.stringify([principal, observation]);
  const options = releaseSearchQueryOptions(locale, raw, readerKey);
  const query = useQuery(options);
  const address = useReaderAddress(null, undefined, locale);
  const responseCurrent = useReaderResponseOrigin(client, options.queryKey, () => true);
  const origin = useRef<ReaderOrigin | null>(null);
  if (!origin.current || !origin.current.isCurrent()) {
    origin.current = {
      lifetime: {},
      isCurrent: () => address.isCurrent() && store.getSnapshot() === observation && responseCurrent(),
    };
  }
  const result =
    query.isFetching || !query.data ? { ...query.data, state: { status: 'loading' as const } } : query.data;
  return <ReleaseSearchPage reader={origin.current} locale={locale} retryHref={location.href} {...result} />;
}
