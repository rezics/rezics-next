import { QueryClient, QueryClientContext, useQuery } from '@tanstack/react-query';
import { useContext, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { operationIsAdmitted, useOperation } from '../kernel/exposure';
import { exposureQuery, sessionQuery, useSession } from '../session/query';
import {
  libraryNavigationQuery,
  matchesPinsOrigin,
  type LibraryNavigationRead,
  type LibraryPinsRead,
} from './pins-read';

export type AcceptedPinsOrigin = {
  lifetime: object;
  isCurrent: () => boolean;
  queryKey?: readonly unknown[];
};
type Admission = { id: string; allowed: boolean; active: boolean; data?: LibraryNavigationRead };
const admission = (allowed: boolean): Admission => ({ id: crypto.randomUUID(), allowed, active: true });
const subscribe = () => () => {};
const previewClient = new QueryClient();
type Boundary = {
  key: string;
  id: string;
  active: boolean;
  mounted: boolean;
  pins: Admission;
  collections: Admission;
};

/** Separate read admissions share a viewer/address, never each other's private authority. */
export function useLibraryReadOrigin(address: string, initialSubject?: string | null) {
  const client = useContext(QueryClientContext) ?? previewClient;
  const session = useSession();
  const hydrated = useSyncExternalStore(subscribe, () => true, () => false);
  const listPins = useOperation('library_pin.list');
  const listCollections = useOperation('collection.list');
  const actual = hydrated ? client.getQueryData(sessionQuery.queryKey) : undefined;
  const viewer = actual ?? session;
  const groups = hydrated ? client.getQueryData(exposureQuery.queryKey) : undefined;
  const pinsAllowed = !hydrated || (actual ? operationIsAdmitted('library_pin.list', groups) : listPins);
  const collectionsAllowed = !hydrated || (actual ? operationIsAdmitted('collection.list', groups) : listCollections);
  const subject = hydrated
    ? viewer.state === 'signed-in' ? viewer.subject ?? null : null
    : initialSubject ?? null;
  const key = JSON.stringify([subject, address]);
  const ref = useRef<Boundary | null>(null);
  const [, rerender] = useState(0);
  if (!ref.current?.active || ref.current.key !== key) {
    if (ref.current) ref.current.active = false;
    ref.current = {
      key, id: crypto.randomUUID(), active: true, mounted: false,
      pins: admission(pinsAllowed), collections: admission(collectionsAllowed),
    };
  }
  const boundary = ref.current;
  for (const [name, allowed] of [['pins', pinsAllowed], ['collections', collectionsAllowed]] as const) {
    if (!boundary[name].active || boundary[name].allowed !== allowed) {
      boundary[name].active = false;
      boundary[name] = admission(allowed);
    }
  }
  const pins = boundary.pins;
  const collections = boundary.collections;
  const viewerCurrent = () => {
    if (!subject || !boundary.active || ref.current !== boundary) return false;
    if (!hydrated) return true;
    const actual = client.getQueryData(sessionQuery.queryKey);
    return actual?.state === 'signed-in' && actual.subject === subject;
  };
  const admitted = (episode: Admission, operation: 'library_pin.list' | 'collection.list') =>
    viewerCurrent() && episode.active && episode.allowed &&
    (!hydrated || operationIsAdmitted(operation, client.getQueryData(exposureQuery.queryKey)));
  const pinsCurrent = () => admitted(pins, 'library_pin.list');
  const collectionsCurrent = () => admitted(collections, 'collection.list');
  const isCurrent = () => viewerCurrent() && pins.active && collections.active;

  useLayoutEffect(() => {
    boundary.mounted = true;
    const observe = () => {
      if (!hydrated || !boundary.active || !subject) return;
      let retired = false;
      if (!viewerCurrent()) {
        boundary.active = false;
        retired = true;
      } else {
        const groups = client.getQueryData(exposureQuery.queryKey);
        for (const [episode, operation] of [[pins, 'library_pin.list'], [collections, 'collection.list']] as const) {
          if (episode.active && episode.allowed !== operationIsAdmitted(operation, groups)) {
            episode.active = false;
            retired = true;
          }
        }
      }
      if (retired) rerender((value) => value + 1);
    };
    const unsubscribe = client.getQueryCache().subscribe(observe);
    observe();
    return () => { boundary.mounted = false; unsubscribe(); };
  }, [boundary, pins, collections, client, hydrated, subject]);
  return {
    subject, hydrated, pins, collections, client,
    lifetime: `${boundary.id}:${pins.id}:${collections.id}`,
    isCurrent,
    pinsCurrent,
    collectionsCurrent,
    mounted: () => boundary.mounted,
  };
}

/** Production's single owning navigation read. No loader or embedded private fallback is consulted. */
export function useCurrentLibraryNavigation(
  locale: string,
  limit: 8 | 100 = 8,
  address = locale,
  enabled = true,
  supplied?: LibraryNavigationRead,
) {
  const origin = useLibraryReadOrigin(JSON.stringify([locale, limit, address, enabled]));
  const options = libraryNavigationQuery(locale, limit, {
    subject: origin.subject ?? '', lifetime: origin.lifetime,
    pins: origin.pins.allowed, collections: origin.collections.allowed,
    isCurrent: () => origin.mounted() && origin.isCurrent(),
  });
  const seed = useRef(false);
  if (!seed.current && origin.hydrated) {
    seed.current = true;
    if (supplied && origin.subject && matchesPinsOrigin(supplied.origin, origin.subject, limit)) {
      if (origin.pinsCurrent() && matchesPinsOrigin(supplied.pins.origin, origin.subject, limit)) origin.pins.data = supplied;
      if (origin.collectionsCurrent()) origin.collections.data = supplied;
    }
  }
  const query = useQuery({
    ...options,
    enabled: enabled && origin.hydrated && !!origin.subject && options.enabled,
  }, origin.client);
  const value = !query.isError && origin.subject && origin.isCurrent() &&
    matchesPinsOrigin(query.data?.origin, origin.subject, limit) ? query.data : undefined;
  if (query.isError) {
    delete origin.pins.data;
    delete origin.collections.data;
  }
  if (value) {
    if (origin.pinsCurrent() && matchesPinsOrigin(value.pins.origin, origin.subject!, limit)) origin.pins.data = value;
    if (origin.collectionsCurrent()) origin.collections.data = value;
  }
  const pins: LibraryPinsRead = origin.pinsCurrent()
    ? (origin.pins.data?.pins ?? { state: query.isError || query.data ? 'unavailable' : 'preparing' })
    : { state: 'closed' };
  const collections = origin.collectionsCurrent() ? origin.collections.data?.collections ?? [] : [];
  const data: LibraryNavigationRead = {
    pins, collections,
    collectionsState: origin.collectionsCurrent()
      ? origin.collections.data?.collectionsState ?? (query.isError || query.data ? 'unavailable' : 'preparing')
      : 'loaded',
  };
  const acceptedPins: AcceptedPinsOrigin = {
    lifetime: origin.pins,
    isCurrent: () => enabled && origin.pinsCurrent() &&
      !!origin.subject && !!origin.pins.data && matchesPinsOrigin(origin.pins.data.pins.origin, origin.subject, limit),
    queryKey: options.queryKey,
  };
  return { data, pinsOrigin: acceptedPins, isError: query.isError };
}
