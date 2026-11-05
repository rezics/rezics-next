import { useRouter } from '@tanstack/react-router';
import { useMemo, useRef, useSyncExternalStore } from 'react';
import { getLocale } from '../../paraglide/runtime.js';
import type { QuestionManagementAddress } from './types';

const stripLocale = (pathname: string) =>
  pathname.replace(/^\/(?:en|zh-Hant|zh-Hans|ja|ko|de|fr|es)(?=\/|$)/, '').replace(/\/$/, '');

function key(location: { pathname: string; search: Record<string, unknown> }) {
  return JSON.stringify([location.pathname, location.search]);
}

function matches(
  location: { pathname: string; search: Record<string, unknown> },
  realmId: string,
  address: Omit<QuestionManagementAddress, 'realmId'> | null,
) {
  if (!address || stripLocale(location.pathname) !== `/realms/${realmId}/questions`) return false;
  const search = location.search;
  return (
    !('invalidAddress' in search) &&
    (search.selectedQuestionId ?? null) === address.selectedQuestionId &&
    (search.cursor ?? null) === address.cursor
  );
}

/** Observe exact question address changes before a retained route match is replaced. */
export function useQuestionManagementAddress(
  realmId: string,
  address: Omit<QuestionManagementAddress, 'realmId'> | null,
  locale: string,
) {
  const router = useRouter({ warn: false });
  const expected = JSON.stringify([realmId, address]);
  const store = useMemo(() => {
    let snapshot = { key: '', matches: !router, episode: 0 };
    const observe = (location: { pathname: string; search: Record<string, unknown> }) => {
      const currentKey = key(location);
      if (snapshot.key === currentKey) return;
      snapshot = {
        key: currentKey,
        matches: matches(location, realmId, address),
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
  const visit = useRef({ snapshot, locale, active: true });
  if (visit.current.snapshot !== snapshot || visit.current.locale !== locale) {
    visit.current.active = false;
    visit.current = { snapshot, locale, active: true };
  }
  const owner = visit.current;
  return {
    key: JSON.stringify([expected, locale, snapshot.key, snapshot.episode]),
    isCurrent: () => {
      if (store.read() !== snapshot || getLocale() !== locale) owner.active = false;
      return owner.active && snapshot.matches;
    },
  };
}
