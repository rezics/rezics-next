import { useEffect, useRef } from 'react';

type ReturnVisit = {
  address: string;
  members: readonly { id?: string }[];
  source: object | undefined;
  active: boolean;
  hash: string | undefined;
  departure: HTMLAnchorElement | undefined;
};

/** One admitted visit can restore only an occurrence in this native page, never fetch another page. */
export function useCollectionComparisonReturn(
  members: readonly { id?: string }[],
  currentHref: string | undefined,
  source?: object,
  admitInitialReturn = true,
) {
  const visit = useRef<ReturnVisit | undefined>(undefined);
  const address = currentHref?.split('#')[0];
  useEffect(() => {
    const previous = visit.current;
    if (!address) return;
    const expected = new URL(address, window.location.origin);
    const current: ReturnVisit = {
      address,
      members,
      source,
      active: true,
      // An initial empty render may still be waiting for its supplied rows. A replaced native page retires it.
      hash: !previous
        ? admitInitialReturn
          ? window.location.hash
          : undefined
        : previous.address === address && previous.source === source && previous.members.length === 0
          ? previous.hash
          : undefined,
      departure: undefined,
    };
    visit.current = current;
    function matchesAddress() {
      return (
        expected.origin === window.location.origin &&
        expected.pathname === window.location.pathname &&
        expected.search === window.location.search
      );
    }
    function retire() {
      current.hash = undefined;
      current.departure = undefined;
    }
    function restore() {
      if (!current.active || !current.hash) return;
      if (!matchesAddress() || current.hash !== window.location.hash) return retire();
      const member = members.find((member) => member.id && current.hash === `#collection-member-${member.id}`);
      if (!member?.id) {
        if (members.length) retire();
        return;
      }
      const element = document.getElementById(`collection-member-${member.id}`);
      if (!element) return retire();
      const focused = document.activeElement;
      const mayFocus = focused === document.body || focused === element || focused === current.departure;
      // Consume the visit before focusing so focus events cannot rearm it.
      retire();
      if (!mayFocus) return;
      element.focus({ preventScroll: true });
      element.scrollIntoView?.({ block: 'nearest' });
    }
    function navigate() {
      if (current.hash !== window.location.hash) current.departure = undefined;
      current.hash = window.location.hash;
      restore();
    }
    function keepFocus() {
      if (document.activeElement !== current.departure) retire();
    }
    restore();
    window.addEventListener('hashchange', navigate);
    window.addEventListener('pageshow', restore);
    document.addEventListener('focusin', keepFocus);
    return () => {
      current.active = false;
      window.removeEventListener('hashchange', navigate);
      window.removeEventListener('pageshow', restore);
      document.removeEventListener('focusin', keepFocus);
    };
  }, [members, address, source, admitInitialReturn]);

  return (anchor: HTMLAnchorElement) => {
    const current = visit.current;
    if (!current?.active) return;
    const occurrence = anchor.closest<HTMLElement>('[data-collection-member-id]')?.dataset.collectionMemberId;
    if (!occurrence || !current.members.some((member) => member.id === occurrence)) return;
    current.hash = `#collection-member-${occurrence}`;
    current.departure = anchor;
  };
}
