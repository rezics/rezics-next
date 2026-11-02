import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  RealmDiscoverySection,
  type RealmDiscoverySort,
  type RealmDiscoveryState,
} from '../community/realm-discovery';
import {
  createRealmDiscoveryWindow,
  realmDiscoveryQueryOptions,
  type RealmDiscoveryReader,
  type RealmDiscoveryWindow,
} from './realm-discovery-loader';
import { createRealmPageProgress } from './realm-page-progress';

/** Search owns request/continuation state; Content owns the only card renderer and GET adapter. */
export function SearchRealmDiscovery(props: {
  initial: RealmDiscoveryState;
  locale: string;
  sort?: RealmDiscoverySort;
  read?: RealmDiscoveryReader;
}) {
  const sort = props.sort ?? 'popular';
  return <SearchRealmDiscoveryPage key={JSON.stringify([props.locale, sort])} {...props} sort={sort} />;
}

function SearchRealmDiscoveryPage({
  initial,
  locale,
  sort = 'popular',
  read,
}: {
  initial: RealmDiscoveryState;
  locale: string;
  sort?: RealmDiscoverySort;
  read?: RealmDiscoveryReader;
}) {
  const client = useQueryClient();
  const initialState = useRef(initial).current;
  const [window, setWindow] = useState<RealmDiscoveryWindow>(() => createRealmDiscoveryWindow(initialState));
  const active = useRef<ReturnType<typeof createRealmPageProgress> | null>(null);

  useEffect(() => {
    const page = createRealmPageProgress({
      initial: initialState.kind === 'loading' ? undefined : initialState,
      read: async ({ cursor, signal }) => {
        const query = read
          ? realmDiscoveryQueryOptions(locale, sort, cursor, read)
          : realmDiscoveryQueryOptions(locale, sort, cursor);
        const cancel = () => void client.cancelQueries({ queryKey: query.queryKey, exact: true });
        signal.addEventListener('abort', cancel, { once: true });
        try {
          return await client.fetchQuery(query);
        } finally {
          signal.removeEventListener('abort', cancel);
        }
      },
      publish: setWindow,
    });
    active.current = page;
    setWindow(page.snapshot());
    void page.start();
    return () => {
      page.dispose();
      if (active.current === page) active.current = null;
    };
  }, [client, initialState, locale, read, sort]);

  return (
    <div className="space-y-3" aria-busy={window.pending}>
      <RealmDiscoverySection
        sort={sort}
        state={window.state}
        locale={locale}
        pending={window.pending}
        retry={window.retry}
        restart={window.restart}
        {...(!window.retry && window.state.kind === 'ready' && window.state.next !== null
          ? { onNext: () => void active.current?.next() }
          : {})}
        {...(!window.pending && window.retry ? { onRetry: () => void active.current?.retry() } : {})}
      />
    </div>
  );
}
