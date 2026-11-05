import { useEffect, useLayoutEffect, useRef } from 'react';
import type { CurationPublication, CurationPublicationVisit, PublicationState } from './curation-publish';

/** Originating publication instance and the actual current visit incarnation. */
export type CurationPublicationFocusOwner = {
  publication: CurationPublication;
  visit?: CurationPublicationVisit;
};

type Pending = {
  publication: CurationPublication;
  incarnation?: number;
  intent: PublicationState['intent'];
  result: PublicationState['result'];
  source: HTMLElement;
  moved: boolean;
  document: Document;
  onFocusIn: (event: FocusEvent) => void;
};

const useFocusLayoutEffect = typeof document === 'undefined' ? useEffect : useLayoutEffect;

function ownerCurrent(owner: CurationPublicationFocusOwner): boolean {
  return owner.visit?.isCurrent() ?? true;
}

function focusMoved(
  target: EventTarget | null,
  host: HTMLElement | null,
  source: HTMLElement,
  document: Document,
): boolean {
  if (target === source || (host !== null && host.contains(target as Node))) return false;
  if ((target === document.body || target === document.documentElement) && !source.isConnected) return false;
  return true;
}

function focusLost(active: Element | null, request: Pending, host: HTMLElement | null, action: HTMLElement | null) {
  return (
    active === request.source ||
    active === host ||
    active === action ||
    ((!request.source.isConnected || request.source === action) &&
      (active === request.document.body || active === request.document.documentElement))
  );
}

/** Local keyboard continuity for an explicitly focused recovery action. */
export function useCurationPublicationFocus(
  owner: CurationPublicationFocusOwner,
  busy: boolean,
  intent: PublicationState['intent'],
  result: PublicationState['result'],
) {
  const regionRef = useRef<HTMLElement>(null);
  const actionRef = useRef<HTMLButtonElement>(null);
  const pending = useRef<Pending | null>(null);
  const ownerRef = useRef(owner);
  ownerRef.current = owner;
  const snapshotRef = useRef({ busy, intent, result });
  snapshotRef.current = { busy, intent, result };
  const incarnation = owner.visit?.incarnation;
  const current = ownerCurrent(owner);

  function clear() {
    const request = pending.current;
    if (!request) return;
    request.document.removeEventListener('focusin', request.onFocusIn, true);
    pending.current = null;
  }

  useEffect(() => () => clear(), []);
  useFocusLayoutEffect(() => {
    const request = pending.current;
    if (!request) return;
    const next = ownerRef.current;
    if (request.publication !== next.publication || request.incarnation !== next.visit?.incarnation || !current) {
      clear();
      return;
    }
    if (request.moved) {
      clear();
      return;
    }
    if (busy) return;
    if (intent === request.intent && result === request.result) return;
    const host = regionRef.current;
    const action = actionRef.current;
    const active = request.document.activeElement;
    if (!focusLost(active, request, host, action)) {
      clear();
      return;
    }
    const target = action?.isConnected ? action : host;
    if (target?.isConnected) target.focus();
    clear();
  }, [busy, intent, result, owner.publication, incarnation, current]);

  return {
    regionRef,
    actionRef,
    noteActivation(source: HTMLElement) {
      clear();
      if (source.ownerDocument.activeElement !== source || !ownerCurrent(ownerRef.current)) return;
      const document = source.ownerDocument;
      const snapshot = snapshotRef.current;
      const request: Pending = {
        publication: ownerRef.current.publication,
        ...(ownerRef.current.visit ? { incarnation: ownerRef.current.visit.incarnation } : {}),
        intent: snapshot.intent,
        result: snapshot.result,
        source,
        moved: false,
        document,
        onFocusIn(event) {
          if (focusMoved(event.target, regionRef.current, request.source, document)) request.moved = true;
        },
      };
      document.addEventListener('focusin', request.onFocusIn, true);
      pending.current = request;
    },
  };
}
