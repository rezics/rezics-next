import { useEffect, useRef } from 'react';
import { useRouter } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useReaderAddress, useWorkspaceAdmission } from '../session/reader';
import { searchQueryOptions } from './search-queries';
import { searchPageForRecovery, searchUnavailablePage } from './search-recovery';
import { discoverySearchHref, searchLoaderDeps, type SearchLoaderDeps } from './search-params';

const operations = [] as const;

/** A returned address is a fresh read. The query cache never supplies a previous window's render. */
export function useSearchQuery(locale: string, params: SearchLoaderDeps, reader?: string) {
  const client = useQueryClient();
  const router = useRouter({ warn: false });
  const admission = useWorkspaceAdmission(operations);
  const address = useReaderAddress(null, undefined, locale);
  const options = searchQueryOptions(locale, params, reader);
  // The route loader has already re-read this address. An immediately stale observer would
  // dispatch a second request when it changes keys after that loader has completed.
  const query = useQuery({ ...options, staleTime: Infinity, refetchOnMount: false });
  const owner = JSON.stringify([
    locale,
    reader,
    admission.value.subject,
    admission.value.viewer,
    admission.value.observation?.id,
  ]);
  const actual = router?.state.location;
  const matches =
    !actual ||
    (actual.pathname.replace(/\/$/, '').endsWith('/search') &&
      discoverySearchHref(locale, searchLoaderDeps(actual.search)) === discoverySearchHref(locale, params));
  const key = JSON.stringify(options.queryKey);
  const readCount = () => client.getQueryState(options.queryKey)?.dataUpdateCount ?? 0;
  const lifetime = useRef({ owner, key, minimum: 0, refresh: false });
  if (lifetime.current.key !== key) lifetime.current = { owner, key, minimum: 0, refresh: false };
  else if (lifetime.current.owner !== owner) lifetime.current = { owner, key, minimum: readCount() + 1, refresh: true };
  const current = lifetime.current;
  useEffect(() => {
    if (!current.refresh || !matches) return;
    current.refresh = false;
    // Reader replacement retires the enrolled request before starting one current read.
    void query.refetch({ cancelRefetch: true });
  }, [owner, key, matches]);
  useEffect(() => {
    if (!router) return;
    return router.subscribe('onBeforeNavigate', ({ toLocation }) => {
      const next = toLocation.pathname.replace(/\/$/, '').endsWith('/search')
        ? searchLoaderDeps(toLocation.search)
        : undefined;
      const target =
        next && !next.invalidInput ? JSON.stringify(searchQueryOptions(locale, next, reader).queryKey) : null;
      // The previous match can still be mounted while its successor loads. Retire even a loader read
      // that has not gained a component observer; a late native reply cannot enroll that abandoned window.
      void client.cancelQueries({
        queryKey: ['search', 'discovery-v1'],
        predicate: (candidate) => JSON.stringify(candidate.queryKey) !== target,
      });
    });
  }, [router, client, locale, reader]);
  useEffect(() => {
    const restored = (event: PageTransitionEvent) => {
      if (event.persisted) void query.refetch({ cancelRefetch: true });
    };
    window.addEventListener('pageshow', restored);
    return () => window.removeEventListener('pageshow', restored);
  }, [locale, JSON.stringify(params), owner]);
  const waiting = !matches || query.isFetching || readCount() < current.minimum || !address.isCurrent();
  const data = waiting
    ? searchPageForRecovery(searchUnavailablePage(params), { status: 'loading' })
    : query.isError
      ? searchUnavailablePage(params)
      : query.data
        ? query.data
        : searchPageForRecovery(searchUnavailablePage(params), { status: query.isPending ? 'loading' : 'unavailable' });
  return {
    data,
    retry: () => {
      void query.refetch();
    },
  };
}
