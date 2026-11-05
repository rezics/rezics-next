import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from '@tanstack/react-router';
import { useEffect, useRef, useSyncExternalStore } from 'react';
import { browserObservation } from '../session';
import { useReaderAddress, useReaderResponseOrigin, type ReaderOrigin } from '../session/reader';
import type { ParsedReleaseSearch } from './release-search';
import { releaseSearchQueryOptions } from './release-search-query';

/** The loader reads once; the observer exposes only that current address and actual reader incarnation. */
export function useReleaseWindowQuery(locale: string, raw: Record<string, unknown>) {
  const client = useQueryClient();
  const router = useRouter({ warn: false });
  const store = browserObservation(client);
  const observation = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot);
  const readerKey = JSON.stringify(observation);
  const options = releaseSearchQueryOptions(locale, raw, 'unknown');
  const query = useQuery({ ...options, staleTime: Infinity, refetchOnMount: false, refetchOnWindowFocus: false });
  const address = useReaderAddress(null, undefined, locale);
  const responseCurrent = useReaderResponseOrigin(client, options.queryKey, () => true);
  const key = JSON.stringify(options.queryKey);
  const readCount = () => client.getQueryState(options.queryKey)?.dataUpdateCount ?? 0;
  const lifetime = useRef({ key, readerKey, minimum: 0, refresh: false });
  if (lifetime.current.key !== key) lifetime.current = { key, readerKey, minimum: 0, refresh: false };
  else if (lifetime.current.readerKey !== readerKey)
    lifetime.current = { key, readerKey, minimum: readCount() + 1, refresh: true };
  const current = lifetime.current;
  useEffect(() => {
    client.removeQueries({
      queryKey: ['release-search'],
      type: 'inactive',
      predicate: (candidate) => JSON.stringify(candidate.queryKey) !== key,
    });
    return () => {
      client.removeQueries({ queryKey: options.queryKey, exact: true, type: 'inactive' });
    };
  }, [client, key]);
  const matches = () => {
    const location = router?.state.location;
    return (
      !location ||
      (location.pathname.replace(/\/$/, '').endsWith('/search/releases') &&
        JSON.stringify(location.search) === JSON.stringify(raw))
    );
  };
  useEffect(() => {
    if (!current.refresh || !matches()) return;
    current.refresh = false;
    void query.refetch({ cancelRefetch: true });
  }, [key, readerKey]);
  useEffect(() => {
    if (!router) return;
    return router.subscribe('onBeforeNavigate', ({ toLocation }) => {
      const target = toLocation.pathname.replace(/\/$/, '').endsWith('/search/releases')
        ? JSON.stringify(releaseSearchQueryOptions(locale, toLocation.search, 'unknown').queryKey)
        : null;
      void client.cancelQueries({
        queryKey: ['release-search'],
        predicate: (candidate) => JSON.stringify(candidate.queryKey) !== target,
      });
    });
  }, [router, client, locale]);
  useEffect(() => {
    const restored = (event: PageTransitionEvent) => {
      if (event.persisted) void query.refetch({ cancelRefetch: true });
    };
    window.addEventListener('pageshow', restored);
    return () => window.removeEventListener('pageshow', restored);
  }, [key, readerKey]);
  const origin = useRef<ReaderOrigin | null>(null);
  if (!origin.current || !origin.current.isCurrent()) {
    origin.current = {
      lifetime: {},
      isCurrent: () => matches() && address.isCurrent() && store.getSnapshot() === observation && responseCurrent(),
    };
  }
  const waiting = !matches() || query.isFetching || readCount() < current.minimum || !address.isCurrent();
  const criteria = JSON.stringify(Object.entries(raw).filter(([name]) => name !== 'cursor'));
  const form = useRef<{ criteria: string; parsed: ParsedReleaseSearch } | undefined>(undefined);
  if (query.data?.parsed) form.current = { criteria, parsed: query.data.parsed };
  const retainedForm = form.current?.criteria === criteria ? form.current.parsed : undefined;
  const retainedSearch = retainedForm ? { ...retainedForm.search } : undefined;
  if (retainedSearch) {
    delete retainedSearch.cursor;
    if (typeof raw.cursor === 'string') retainedSearch.cursor = raw.cursor;
  }
  const result =
    waiting || !query.data
      ? {
          ...query.data,
          state: { status: query.isError && !waiting ? ('unavailable' as const) : ('loading' as const) },
        }
      : query.data;
  return {
    result:
      result.parsed || !retainedForm
        ? result
        : {
            ...result,
            parsed: {
              ...retainedForm,
              search: retainedSearch!,
            },
          },
    reader: origin.current,
  };
}
