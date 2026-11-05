import { useRouter } from '@tanstack/react-router';
import { useMemo, useRef, useSyncExternalStore } from 'react';
import { getLocale } from '../../paraglide/runtime.js';
import { classificationAddressKey, classificationFrontier, OWN_CLASSIFICATIONS_PATH } from './inventory';
import type { ClassificationFrontier } from './types';

/** Includes the selected pair and navigation in flight, before the retained route match changes. */
export function useClassificationAddress(frontier: ClassificationFrontier | null, locale: string) {
  const router = useRouter({ warn: false });
  const expected = classificationAddressKey(frontier);
  const store = useMemo(() => {
    let snapshot = { key: '', matches: !router, episode: 0 };
    const observe = (location: { pathname: string; search: Record<string, unknown> }) => {
      const key = JSON.stringify([location.pathname, location.search]);
      if (snapshot.key === key) return;
      const path = location.pathname.replace(/^\/(?:en|zh-Hant|zh-Hans|ja|ko|de|fr|es)(?=\/|$)/, '');
      const actual = classificationFrontier(location.search);
      snapshot = {
        key,
        matches: path.replace(/\/$/, '') === OWN_CLASSIFICATIONS_PATH && classificationAddressKey(actual) === expected,
        episode: snapshot.episode + 1,
      };
    };
    if (router) observe(router.state.location);
    return {
      read: () => snapshot,
      subscribe: (notify: () => void) =>
        router?.subscribe('onBeforeNavigate', ({ toLocation }) => {
          observe(toLocation);
          notify();
        }) ?? (() => {}),
    };
  }, [router, expected]);
  const snapshot = useSyncExternalStore(store.subscribe, store.read, store.read);
  const latest = useRef({ snapshot, locale, active: true });
  if (latest.current.snapshot !== snapshot || latest.current.locale !== locale) {
    latest.current.active = false;
    latest.current = { snapshot, locale, active: true };
  }
  const visit = latest.current;
  return {
    key: JSON.stringify([expected, locale, snapshot.key, snapshot.episode]),
    isCurrent: () => {
      if (store.read() !== snapshot || getLocale() !== locale) visit.active = false;
      return visit.active && snapshot.matches;
    },
  };
}
