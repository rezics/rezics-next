import { useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { RealmDiscoverySection, type RealmDiscoverySort, type RealmDiscoveryState } from '../community/realm-discovery';
import {
  readRealmDiscovery,
  realmDiscoveryQueryOptions,
  type RealmDiscoveryReader,
  type RealmDiscoveryWindow,
} from './realm-discovery-loader';
import { realmDiscoveryOwnedWindow, sameRealmDiscoveryOwner, type RealmDiscoveryOwner } from './realm-discovery-owner';
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
  read = readRealmDiscovery,
}: {
  initial: RealmDiscoveryState;
  locale: string;
  sort?: RealmDiscoverySort;
  read?: RealmDiscoveryReader;
}) {
  const client = useQueryClient();
  const owner = useMemo<RealmDiscoveryOwner>(() => ({ locale, sort, read, client }), [locale, sort, read, client]);
  const initialState = useRef(initial).current;
  const [snapshot, setSnapshot] = useState<RealmDiscoveryWindow & { owner: RealmDiscoveryOwner }>();
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const active = useRef<ReturnType<typeof createRealmPageProgress> | null>(null);
  const window = realmDiscoveryOwnedWindow(snapshot, owner, initialState);

  useEffect(() => {
    const replacing = snapshotRef.current !== undefined && !sameRealmDiscoveryOwner(snapshotRef.current.owner, owner);
    const page = createRealmPageProgress({
      ...(initialState.kind !== 'loading' && !replacing ? { initial: initialState } : {}),
      read: async ({ cursor }) => client.fetchQuery(realmDiscoveryQueryOptions(locale, sort, cursor, read)),
      publish: (next) => setSnapshot({ ...next, owner }),
    });
    active.current = page;
    setSnapshot({ ...page.snapshot(), owner });
    void page.start();
    return () => {
      page.dispose();
      if (active.current === page) active.current = null;
    };
  }, [client, initialState, locale, owner, read, sort]);

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
