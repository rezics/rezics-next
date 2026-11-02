import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';

const useFocusLayoutEffect = typeof document === 'undefined' ? useEffect : useLayoutEffect;

/** Visit identity for a directory Next, Restart or Retry. Replacement of any field retires the intent. */
export type PopulationPageFocusOwner = {
  subject: string;
  question: string;
  locale: string;
  read: unknown;
  lease?: string;
  reader?: string | null;
  isCurrent?: () => boolean;
};

type Pending = {
  owner: PopulationPageFocusOwner;
  requestKey: string;
  source: HTMLElement;
  moved: boolean;
  document: Document;
  onFocusIn: (event: FocusEvent) => void;
};

export function populationPageFocusOwnerCurrent(
  pending: PopulationPageFocusOwner,
  current: PopulationPageFocusOwner,
): boolean {
  return (
    pending.subject === current.subject &&
    pending.question === current.question &&
    pending.locale === current.locale &&
    pending.read === current.read &&
    (pending.lease ?? '') === (current.lease ?? '') &&
    (pending.reader ?? null) === (current.reader ?? null) &&
    (current.isCurrent?.() ?? true)
  );
}

/** Directory source-status recovery is still this navigation; any other control or region is not. */
export function populationPageFocusMoved(
  target: EventTarget | null,
  source: HTMLElement,
  document: Document,
  status?: HTMLElement | null,
): boolean {
  if (target === source) return false;
  if (status && target instanceof Node && status.contains(target)) return false;
  if ((target === document.body || target === document.documentElement) && !source.isConnected) return false;
  return true;
}

function stillOwned(
  active: Element | null,
  source: HTMLElement,
  document: Document,
  status?: HTMLElement | null,
): boolean {
  if (active === source || active === document.body || active === document.documentElement) return true;
  return Boolean(status && active && status.contains(active));
}

/** First enabled choice or control of the settled directory page. */
export function populationPageFocusTarget(region: HTMLElement | null): HTMLElement | null {
  return region?.querySelector<HTMLElement>('input:not(:disabled), button:not(:disabled)') ?? null;
}

/** Bound keyboard continuation for the exact pending directory request. */
export function usePopulationPageFocus({
  owner,
  requestKey,
  ready,
  region,
}: {
  owner: PopulationPageFocusOwner;
  requestKey: string;
  ready: boolean;
  region: RefObject<HTMLElement | null>;
}) {
  const pending = useRef<Pending | null>(null);
  const ownerRef = useRef(owner);
  ownerRef.current = owner;

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
    if (!populationPageFocusOwnerCurrent(request.owner, current) || request.moved) {
      clear();
      return;
    }
    if (!ready || request.requestKey !== requestKey) return;
    const status = region.current?.querySelector<HTMLElement>('[data-source="directory"]');
    if (!stillOwned(request.document.activeElement, request.source, request.document, status)) {
      clear();
      return;
    }
    const target = populationPageFocusTarget(region.current);
    clear();
    target?.focus();
  }, [owner.subject, owner.question, owner.locale, owner.lease, owner.reader, owner.read, requestKey, ready]);

  return {
    capture(source: HTMLElement, nextRequestKey: string) {
      clear();
      if (source.ownerDocument.activeElement !== source || !(ownerRef.current.isCurrent?.() ?? true)) return;
      const document = source.ownerDocument;
      const captured: Pending = {
        owner: ownerRef.current,
        requestKey: nextRequestKey,
        source,
        moved: false,
        document,
        onFocusIn(event) {
          const status = region.current?.querySelector<HTMLElement>('[data-source="directory"]');
          if (populationPageFocusMoved(event.target, captured.source, document, status)) captured.moved = true;
        },
      };
      document.addEventListener('focusin', captured.onFocusIn, true);
      pending.current = captured;
    },
  };
}
