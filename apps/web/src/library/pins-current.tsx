import { CancelledError, QueryClient, QueryClientContext, useQuery } from '@tanstack/react-query';
import { useContext, useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import { useLibraryWorkspaceAdmission } from './library-workspace-admission';
import { useSession } from '../session/query';
import { getLocale } from '../paraglide/runtime.js';
import { useHistoryAddress, useHistoryReadOrigin } from './history-current-origin';
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
type Admission = {
  id: string;
  allowed: boolean;
  active: boolean;
  data?: LibraryNavigationRead;
  queryKey?: readonly unknown[];
};
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

const navigationOperations = ['library_pin.list', 'collection.list'] as const;

/** Separate read admissions share a viewer/address, never each other's private authority. */
export function useLibraryReadOrigin(address: string, initialSubject?: string | null) {
  const supplied = useContext(QueryClientContext);
  const client = supplied ?? previewClient;
  useSession();
  const hydrated = useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
  const { store, value } = useLibraryWorkspaceAdmission(navigationOperations);
  const location = useHistoryAddress(null, undefined, getLocale());
  const subject = hydrated ? value.subject : (initialSubject ?? null);
  const key = JSON.stringify([subject, value.viewer, address, location.key]);
  const ref = useRef<Boundary | null>(null);
  if (!ref.current || ref.current.key !== key) {
    if (ref.current) ref.current.active = false;
    ref.current = {
      key,
      id: crypto.randomUUID(),
      active: true,
      mounted: false,
      pins: admission(!hydrated || value.granted[0] === true),
      collections: admission(!hydrated || value.granted[1] === true),
    };
  }
  const boundary = ref.current;
  const versions = value.episodes;
  const seen = useRef({ boundary, versions });
  for (const [name, index] of [
    ['pins', 0],
    ['collections', 1],
  ] as const) {
    const allowed = !hydrated || value.granted[index] === true;
    if (seen.current.boundary === boundary && seen.current.versions[index] !== versions[index]) {
      boundary[name].active = false;
      boundary[name] = admission(allowed);
    } else boundary[name].allowed = allowed;
  }
  seen.current = { boundary, versions };
  const pins = boundary.pins;
  const collections = boundary.collections;
  const viewerCurrent = () => {
    const now = store.read();
    return (
      !!subject &&
      boundary.active &&
      ref.current === boundary &&
      location.isCurrent() &&
      (!hydrated || (!!supplied && now.subject === subject && now.viewer === value.viewer))
    );
  };
  const current = (episode: Admission, index: number) =>
    viewerCurrent() &&
    episode.active &&
    episode.allowed &&
    (!hydrated || (store.read().dispatch[index] === value.dispatch[index] && store.read().allowed[index] === true));
  const pinsCurrent = () => current(pins, 0);
  const collectionsCurrent = () => current(collections, 1);
  const isCurrent = () =>
    viewerCurrent() && (!pins.allowed || pinsCurrent()) && (!collections.allowed || collectionsCurrent());
  useLayoutEffect(() => {
    if (boundary.active) boundary.mounted = true;
    return () => {
      boundary.mounted = false;
    };
  }, [boundary]);
  return {
    subject,
    hydrated,
    pins,
    collections,
    workspaceAdmission: store,
    client,
    lifetime: `${boundary.id}:${pins.id}:${collections.id}`,
    isCurrent,
    pinsCurrent,
    collectionsCurrent,
    mounted: () => boundary.mounted,
  };
}

/** Production's single owning navigation read. No loader or embedded private fallback is consulted. */
export function useCurrentLibraryNavigation(locale: string, limit: 8 | 100 = 8, address = locale, enabled = true) {
  const origin = useLibraryReadOrigin(JSON.stringify([locale, limit, address, enabled]));
  const options = libraryNavigationQuery(locale, limit, {
    subject: origin.subject ?? '',
    lifetime: origin.lifetime,
    pins: origin.pins.allowed,
    collections: origin.collections.allowed,
    isCurrent: () => origin.mounted() && origin.isCurrent(),
  });
  const query = useQuery(
    {
      ...options,
      queryFn: async (context) => {
        try {
          return await options.queryFn!(context);
        } catch (error) {
          if (!origin.isCurrent()) throw new CancelledError({ silent: true, revert: true });
          throw error;
        }
      },
      enabled: enabled && origin.hydrated && !!origin.subject && options.enabled === true,
      staleTime: Infinity,
      refetchOnMount: false,
    },
    origin.client,
  );
  const readCurrent = useHistoryReadOrigin(origin.client, options.queryKey, (value) => {
    const read = value as LibraryNavigationRead | undefined;
    return (
      !!origin.subject &&
      matchesPinsOrigin(read?.origin, origin.subject, limit) &&
      (!origin.pins.allowed || matchesPinsOrigin(read?.pins.origin, origin.subject, limit))
    );
  });
  const value =
    !query.isError &&
    origin.subject &&
    origin.isCurrent() &&
    matchesPinsOrigin(query.data?.origin, origin.subject, limit)
      ? query.data
      : undefined;
  if (query.isError) {
    delete origin.pins.data;
    delete origin.collections.data;
  }
  if (value) {
    if (origin.pinsCurrent() && matchesPinsOrigin(value.pins.origin, origin.subject!, limit)) {
      origin.pins.data = value;
      origin.pins.queryKey = options.queryKey;
    }
    if (origin.collectionsCurrent()) origin.collections.data = value;
  }
  const pins: LibraryPinsRead = origin.pinsCurrent()
    ? (origin.pins.data?.pins ?? { state: query.isError || query.data ? 'unavailable' : 'preparing' })
    : { state: 'closed' };
  const collections = origin.collectionsCurrent() ? (origin.collections.data?.collections ?? []) : [];
  const data: LibraryNavigationRead = {
    pins,
    collections,
    collectionsState: origin.collectionsCurrent()
      ? (origin.collections.data?.collectionsState ?? (query.isError || query.data ? 'unavailable' : 'preparing'))
      : 'loaded',
  };
  const acceptedPins: AcceptedPinsOrigin = {
    lifetime: origin.pins,
    isCurrent: () =>
      enabled &&
      readCurrent() &&
      origin.pinsCurrent() &&
      !!origin.subject &&
      !!origin.pins.data &&
      origin.client.getQueryState(origin.pins.queryKey ?? options.queryKey)?.status === 'success' &&
      origin.client.getQueryData(origin.pins.queryKey ?? options.queryKey) === origin.pins.data &&
      matchesPinsOrigin(origin.pins.data.pins.origin, origin.subject, limit),
    queryKey: origin.pins.queryKey ?? options.queryKey,
  };
  return { data, pinsOrigin: acceptedPins, isError: query.isError };
}
