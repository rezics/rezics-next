import { useEffect, useLayoutEffect, useRef } from 'react';

/** Current public or population source owner. Replacement of any field retires pending recovery. */
export type RatingRetryOwner = {
  subject: string;
  locale: string;
  source: string;
  population?: string;
  incarnation?: string;
  isCurrent?: () => boolean;
};

type Pending = {
  owner: RatingRetryOwner;
  source: HTMLElement;
  moved: boolean;
  document: Document;
  onFocusIn: (event: FocusEvent) => void;
};

const useFocusLayoutEffect = typeof document === 'undefined' ? useEffect : useLayoutEffect;

export function ratingRetryOwnerKey(owner: RatingRetryOwner): string {
  return JSON.stringify([owner.subject, owner.locale, owner.source, owner.population ?? '', owner.incarnation ?? '']);
}

export function ratingRetryOwnerCurrent(owner: RatingRetryOwner): boolean {
  return owner.isCurrent?.() ?? true;
}

export function ratingRetryFocusMoved(
  target: EventTarget | null,
  host: HTMLElement | null,
  source: HTMLElement,
  document: Document,
): boolean {
  if (target === source || (host !== null && host.contains(target as Node))) return false;
  if ((target === document.body || target === document.documentElement) && !source.isConnected) return false;
  return true;
}

function focusLost(active: Element | null, request: Pending, host: HTMLElement | null, retry: HTMLElement | null) {
  return (
    active === request.source ||
    active === host ||
    active === retry ||
    ((!request.source.isConnected || request.source === retry) &&
      (active === request.document.body || active === request.document.documentElement))
  );
}

/** Source-local keyboard recovery; pending state lives on this instance, never a global manager. */
export function useRatingSourceRetryFocus(owner: RatingRetryOwner, kind: string) {
  const targetRef = useRef<HTMLDivElement>(null);
  const retryRef = useRef<HTMLButtonElement>(null);
  const pending = useRef<Pending | null>(null);
  const ownerRef = useRef(owner);
  ownerRef.current = owner;
  const key = ratingRetryOwnerKey(owner);

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
    const current = ownerRef.current;
    if (ratingRetryOwnerKey(request.owner) !== ratingRetryOwnerKey(current) || !ratingRetryOwnerCurrent(current)) {
      clear();
      return;
    }
    if (request.moved) {
      clear();
      return;
    }
    const host = targetRef.current;
    const retry = retryRef.current;
    const active = request.document.activeElement;
    if (kind === 'idle') {
      if (retry?.isConnected && active === retry) return;
      if (host && focusLost(active, request, host, retry)) host.focus();
      return;
    }
    if (!focusLost(active, request, host, retry)) {
      clear();
      return;
    }
    const target = retry?.isConnected ? retry : host;
    if (target?.isConnected) target.focus();
    clear();
  }, [kind, key]);

  return {
    targetRef,
    retryRef,
    noteActivation(source: HTMLButtonElement) {
      clear();
      if (source.ownerDocument.activeElement !== source || !ratingRetryOwnerCurrent(ownerRef.current)) return;
      const document = source.ownerDocument;
      const request: Pending = {
        owner: ownerRef.current,
        source,
        moved: false,
        document,
        onFocusIn(event) {
          if (ratingRetryFocusMoved(event.target, targetRef.current, request.source, document)) request.moved = true;
        },
      };
      document.addEventListener('focusin', request.onFocusIn, true);
      pending.current = request;
    },
  };
}
