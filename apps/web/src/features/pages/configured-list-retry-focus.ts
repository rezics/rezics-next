import { useEffect, useLayoutEffect, useRef } from 'react';

export type ConfiguredListRetryFocusOwner = {
  route: string;
  reader: string;
  queryClient: object;
  incarnation: string;
  isCurrent(): boolean;
};

type Outcome = 'pending' | 'unavailable' | 'ready';
type Owner = Omit<ConfiguredListRetryFocusOwner, 'isCurrent'>;
type Pending = {
  owner: Owner;
  source: HTMLButtonElement;
  moved: boolean;
  document: Document;
  focused: HTMLElement | null;
  onFocusIn: (event: FocusEvent) => void;
};

const useFocusLayoutEffect = typeof document === 'undefined' ? useEffect : useLayoutEffect;

/** Keeps one deliberate Retry focused on its current recovery or result while the admitted list read settles. */
export function useConfiguredListRetryFocus(owner: ConfiguredListRetryFocusOwner, outcome: Outcome, retrying: boolean) {
  const statusRef = useRef<HTMLParagraphElement>(null);
  const retryRef = useRef<HTMLButtonElement>(null);
  const resultRef = useRef<HTMLDivElement>(null);
  const pending = useRef<Pending | null>(null);
  const ownerRef = useRef(owner);
  ownerRef.current = owner;

  function clear() {
    const request = pending.current;
    if (!request) return;
    request.document.removeEventListener('focusin', request.onFocusIn, true);
    pending.current = null;
  }

  useFocusLayoutEffect(() => () => clear(), []);
  useFocusLayoutEffect(() => {
    const request = pending.current;
    if (!request) return;
    const current = ownerRef.current;
    if (
      request.owner.route !== current.route ||
      request.owner.reader !== current.reader ||
      request.owner.queryClient !== current.queryClient ||
      !current.isCurrent()
    ) {
      clear();
      return;
    }
    if (request.owner.incarnation !== current.incarnation) {
      if (!retrying) {
        clear();
        return;
      }
      // A deliberate Realm retry follows its admitted same-reader refresh to the current incarnation.
      request.owner.incarnation = current.incarnation;
    }
    if (request.moved) {
      clear();
      return;
    }

    const active = request.document.activeElement;
    const lost =
      active === request.source ||
      active === request.focused ||
      active === retryRef.current ||
      active === statusRef.current ||
      active === resultRef.current ||
      active === request.document.body ||
      active === request.document.documentElement;
    if (!lost) {
      clear();
      return;
    }
    if (retrying || outcome === 'pending') {
      const status = statusRef.current;
      if (status?.isConnected && active !== status) {
        request.focused = status;
        status.focus();
      }
      return;
    }

    const target =
      outcome === 'ready'
        ? resultRef.current
        : retryRef.current?.isConnected && !retryRef.current.disabled
          ? retryRef.current
          : statusRef.current;
    if (target?.isConnected) target.focus();
    clear();
  }, [owner.route, owner.reader, owner.queryClient, owner.incarnation, owner.isCurrent, outcome, retrying]);

  return {
    statusRef,
    retryRef,
    resultRef,
    noteActivation(source: HTMLButtonElement) {
      clear();
      const current = ownerRef.current;
      if (source.ownerDocument.activeElement !== source || !current.isCurrent()) return;
      const document = source.ownerDocument;
      const request: Pending = {
        owner: {
          route: current.route,
          reader: current.reader,
          queryClient: current.queryClient,
          incarnation: current.incarnation,
        },
        source,
        moved: false,
        document,
        focused: null,
        onFocusIn(event) {
          const lostToPage = event.target === document.body || event.target === document.documentElement;
          if (
            event.target !== request.source &&
            event.target !== request.focused &&
            !(lostToPage && (!request.source.isConnected || request.source.matches(':disabled')))
          )
            request.moved = true;
        },
      };
      document.addEventListener('focusin', request.onFocusIn, true);
      pending.current = request;
    },
  };
}
