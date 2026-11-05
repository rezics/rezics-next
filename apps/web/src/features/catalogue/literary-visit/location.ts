import { useSyncExternalStore } from 'react';
import { literaryVisitLocation } from './navigation';

function subscribe(listener: () => void) {
  if (typeof window === 'undefined') return () => {};
  window.addEventListener('popstate', listener);
  return () => window.removeEventListener('popstate', listener);
}

function search() {
  return typeof window === 'undefined' ? '' : window.location.search;
}

/** Keep current address intent across browser back/forward while never retaining a former response. */
export function useLiteraryVisitLocation() {
  const current = useSyncExternalStore(subscribe, search, () => '');
  return literaryVisitLocation(current);
}
