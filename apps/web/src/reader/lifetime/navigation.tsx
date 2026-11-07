import { createContext, useContext, useMemo, useRef, useSyncExternalStore } from 'react';
import { QueryClientContext } from '@tanstack/react-query';
import { useRouter, type AnyRouter } from '@tanstack/react-router';
import type { ReaderNavigation } from './contract';
import { browserObservation } from './observation';

/** Optional host navigation capability; session identity stays in the existing QueryClient. */
export const ReaderNavigationContext = createContext<ReaderNavigation | undefined>(undefined);
const emptySubscribe = () => () => {};
const browserAddress = () => (typeof window === 'undefined' ? '' : window.location.href);

/** Share departure observation while readers are mounted; an idle host reads the Router's current address. */
function routerNavigation(router: AnyRouter): ReaderNavigation {
  let address = router.latestLocation.href;
  const listeners = new Set<() => void>();
  let stop: (() => void) | undefined;
  return {
    address: () => (stop ? address : router.latestLocation.href),
    subscribe(changed) {
      if (!stop) {
        address = router.latestLocation.href;
        stop = router.subscribe('onBeforeNavigate', ({ toLocation }) => {
          address = toLocation.href;
          for (const notify of [...listeners]) notify();
        });
      }
      listeners.add(changed);
      return () => {
        listeners.delete(changed);
        if (listeners.size === 0) {
          stop?.();
          stop = undefined;
        }
      };
    },
  };
}

/** Bind the installed shell Router without introducing session state or another session provider. */
export function useReaderNavigationHost(): ReaderNavigation {
  const router = useRouter();
  return useMemo(() => routerNavigation(router), [router]);
}

/** Prepared mounts may already have a Router without mounting the application shell. */
function useReaderNavigation() {
  const supplied = useContext(ReaderNavigationContext);
  const router = useRouter({ warn: false });
  const isolated = useMemo<ReaderNavigation | undefined>(() => {
    if (supplied || !router) return undefined;
    return routerNavigation(router);
  }, [supplied, router]);
  return supplied ?? isolated;
}

/** One irreversible address/locale visit. The host observes navigation before a replacement render. */
export function useReaderVisit<Locale extends string>(scope: string, locale: Locale, readLocale: () => Locale) {
  const navigation = useReaderNavigation();
  const client = useContext(QueryClientContext);
  const visit = useMemo(() => {
    const address = browserAddress();
    const route = navigation?.address();
    let active = true;
    const listeners = new Set<() => void>();
    const retire = () => {
      if (!active) return;
      active = false;
      for (const notify of [...listeners]) notify();
    };
    const current = () => {
      if (readLocale() !== locale || browserAddress() !== address || (navigation && navigation.address() !== route))
        retire();
      return active;
    };
    return {
      locale,
      current,
      retire,
      subscribe(notify: () => void) {
        listeners.add(notify);
        const changed = () => {
          current();
        };
        const stopCache = client && browserObservation(client).subscribeCache(changed);
        const stop = navigation?.subscribe(changed);
        if (typeof window !== 'undefined') {
          window.addEventListener('popstate', changed);
          window.addEventListener('hashchange', changed);
          window.addEventListener('pagehide', retire);
        }
        current();
        return () => {
          listeners.delete(notify);
          stop?.();
          stopCache?.();
          if (typeof window !== 'undefined') {
            window.removeEventListener('popstate', changed);
            window.removeEventListener('hashchange', changed);
            window.removeEventListener('pagehide', retire);
          }
        };
      },
    };
  }, [navigation, client, scope, locale, readLocale]);
  const previous = useRef(visit);
  if (previous.current !== visit) previous.current.retire();
  previous.current = visit;
  useSyncExternalStore(visit.subscribe, visit.current, () => true);
  return visit;
}

/** Cursor/address observation consumes the host's navigation capability; isolated mounts need no Router. */
export function useReaderAddress(
  path: string | null,
  cursor: string | undefined,
  locale: string,
  readLocale: () => string,
) {
  const navigation = useReaderNavigation();
  const initialCursor = navigation ? undefined : cursor;
  const store = useMemo(() => {
    let snapshot = { cursor: initialCursor || null, active: true, episode: 0, key: '' };
    const observe = () => {
      if (!navigation) return snapshot;
      const location = new URL(navigation.address(), 'https://reader.invalid');
      const nextCursor = location.searchParams.get('cursor') || null;
      const active = path === null || location.pathname.replace(/\/$/, '') === path;
      const key = JSON.stringify([location.pathname, path === null ? location.search : nextCursor]);
      if (snapshot.key !== key) snapshot = { cursor: nextCursor, active, episode: snapshot.episode + 1, key };
      return snapshot;
    };
    observe();
    return {
      read: () => snapshot,
      subscribe: (notify: () => void) =>
        navigation
          ? navigation.subscribe(() => {
              observe();
              notify();
            })
          : emptySubscribe(),
    };
  }, [navigation, path, initialCursor]);
  const snapshot = useSyncExternalStore(store.subscribe, store.read, store.read);
  const ref = useRef({ snapshot, locale, active: true, generation: 0 });
  if (!ref.current.active || ref.current.snapshot !== snapshot || ref.current.locale !== locale) {
    ref.current.active = false;
    ref.current = { snapshot, locale, active: true, generation: ref.current.generation + 1 };
  }
  const address = ref.current;
  return {
    cursor: navigation ? snapshot.cursor : cursor || null,
    key: JSON.stringify([
      path,
      navigation ? snapshot.cursor : cursor || null,
      locale,
      snapshot.episode,
      address.generation,
    ]),
    isCurrent: () => {
      if (store.read() !== snapshot || readLocale() !== locale) address.active = false;
      return address.active && snapshot.active;
    },
  };
}
