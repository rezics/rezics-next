import type { QueryClient } from '@tanstack/react-query';
import type { RealmDiscoverySort, RealmDiscoveryState } from '../community/realm-discovery';
import {
  createRealmDiscoveryWindow,
  type RealmDiscoveryReader,
  type RealmDiscoveryWindow,
} from './realm-discovery-loader';

/** Locale/sort remounts still reset initial state; the actual reader and cache client own the live window. */
export type RealmDiscoveryOwner = Readonly<{
  locale: string;
  sort: RealmDiscoverySort;
  read: RealmDiscoveryReader;
  client: QueryClient;
}>;

export function sameRealmDiscoveryOwner(
  left: RealmDiscoveryOwner | undefined,
  right: RealmDiscoveryOwner,
): boolean {
  return Boolean(
    left &&
      left.locale === right.locale &&
      left.sort === right.sort &&
      left.read === right.read &&
      left.client === right.client,
  );
}

/** Hide a replaced reader's rows during render. A first mount still shows its initial window. */
export function realmDiscoveryOwnedWindow(
  snapshot: (RealmDiscoveryWindow & { owner: RealmDiscoveryOwner }) | undefined,
  owner: RealmDiscoveryOwner,
  initial: RealmDiscoveryState,
): RealmDiscoveryWindow {
  if (snapshot && sameRealmDiscoveryOwner(snapshot.owner, owner)) return snapshot;
  if (!snapshot) return createRealmDiscoveryWindow(initial);
  return createRealmDiscoveryWindow({ kind: 'loading' });
}
