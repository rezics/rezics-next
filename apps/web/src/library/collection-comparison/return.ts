import { useEffect, useRef, useState } from 'react';

type ReturnVisit = {
  address: string;
  members: readonly { id?: string }[];
  source: object | undefined;
  active: boolean;
  hash: string | undefined;
  departure: HTMLAnchorElement | undefined;
};

export type CollectionComparisonReturnState = 'none' | 'waiting' | 'present' | 'missing';

export function collectionComparisonReturnState(
  hash: string | undefined,
  members: readonly { id?: string }[],
  pageReady: boolean,
  admitted: boolean,
): CollectionComparisonReturnState {
  const match = hash?.match(/^#collection-member-([0-9a-f-]{36})$/i);
  if (!admitted || !match) return 'none';
  if (!pageReady) return 'waiting';
  return members.some((member) => member.id === match[1]) ? 'present' : 'missing';
}

type MissingOccurrence = { address: string; source: object | undefined; id: string };

/** One admitted visit restores only its exact loaded occurrence and reports when that occurrence is absent. */
export function useCollectionComparisonReturn(
  members: readonly { id?: string }[],
  currentHref: string | undefined,
  source?: object,
  admitInitialReturn = true,
  pageReady = true,
) {
  const visit = useRef<ReturnVisit | undefined>(undefined);
  const [missing, setMissing] = useState<MissingOccurrence | undefined>(undefined);
  const address = currentHref?.split('#')[0];
  const missingOccurrence = Boolean(missing && missing.address === address && missing.source === source);
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
    setMissing(undefined);
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
      const state = collectionComparisonReturnState(current.hash, members, pageReady, current.active);
      if (state === 'none' || state === 'waiting') return;
      const occurrence = /^#collection-member-([0-9a-f-]{36})$/i.exec(current.hash)?.[1];
      if (state === 'missing' && occurrence) {
        setMissing({ address: current.address, source, id: occurrence });
        retire();
        return;
      }
      const member = members.find((member) => member.id === occurrence);
      if (!member?.id) return retire();
      const element = document.getElementById(`collection-member-${member.id}`);
      if (!element) return;
      const focused = document.activeElement;
      const mayFocus = focused === document.body || focused === element || focused === current.departure;
      // Consume the visit before focusing so focus events cannot rearm it.
      retire();
      setMissing(undefined);
      if (!mayFocus) return;
      element.focus({ preventScroll: true });
      element.scrollIntoView?.({ block: 'nearest' });
    }
    function navigate() {
      if (current.hash !== window.location.hash) {
        current.departure = undefined;
        setMissing(undefined);
      }
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
  }, [members, address, source, admitInitialReturn, pageReady]);

  return {
    missingOccurrence,
    admitReferenceReturn: (anchor: HTMLAnchorElement) => {
      const current = visit.current;
      if (!current?.active) return;
      const occurrence = anchor.closest<HTMLElement>('[data-collection-member-id]')?.dataset.collectionMemberId;
      if (!occurrence || !current.members.some((member) => member.id === occurrence)) return;
      current.hash = `#collection-member-${occurrence}`;
      current.departure = anchor;
      setMissing(undefined);
    },
  };
}
