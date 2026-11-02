import { useEffect, useLayoutEffect as useBrowserLayoutEffect, useRef } from 'react';

const useFocusLayoutEffect = typeof document === 'undefined' ? useEffect : useBrowserLayoutEffect;

export type SearchRetryOwner = {
  scope: string;
  locale: string;
  session: string | null;
};

export function searchRetryOwnerCurrent(pending: SearchRetryOwner, current: SearchRetryOwner): boolean {
  return pending.scope === current.scope && pending.locale === current.locale && pending.session === current.session;
}

type PendingRetryFocus = {
  owner: SearchRetryOwner;
  source: HTMLButtonElement;
  moved: boolean;
};

function fallbackFocus(active: Element | null, source: HTMLButtonElement): boolean {
  const document = source.ownerDocument;
  return active === source || active === document.body || active === document.documentElement;
}

/** Restore a surviving Retry, otherwise the named result/recovery region of the same owner. */
export function searchRetryFocusTarget({
  pending,
  current,
  settled,
  active,
  retry,
  region,
}: {
  pending: PendingRetryFocus | null;
  current: SearchRetryOwner;
  settled: boolean;
  active: Element | null;
  retry: HTMLElement | null;
  region: HTMLElement | null;
}): HTMLElement | null {
  if (!pending || !settled || pending.moved || !searchRetryOwnerCurrent(pending.owner, current)) return null;
  if (!fallbackFocus(active, pending.source)) return null;
  if (retry?.isConnected) return retry;
  return region?.isConnected ? region : null;
}

export function useSearchRetryFocus(current: SearchRetryOwner, settled: boolean) {
  const regionRef = useRef<HTMLElement>(null);
  const retryRef = useRef<HTMLButtonElement>(null);
  const pending = useRef<(PendingRetryFocus & { document: Document; onFocusIn: (event: FocusEvent) => void }) | null>(
    null,
  );

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
    if (!searchRetryOwnerCurrent(request.owner, current)) {
      clear();
      return;
    }
    if (!settled) return;
    const target = searchRetryFocusTarget({
      pending: request,
      current,
      settled: true,
      active: request.document.activeElement,
      retry: retryRef.current,
      region: regionRef.current,
    });
    clear();
    target?.focus();
  }, [current.scope, current.locale, current.session, settled]);

  return {
    regionRef,
    retryRef,
    captureRetryFocus(source: HTMLButtonElement) {
      if (source.ownerDocument.activeElement !== source) return;
      clear();
      const document = source.ownerDocument;
      const request = {
        owner: { scope: current.scope, locale: current.locale, session: current.session },
        source,
        moved: false,
        document,
        onFocusIn(event: FocusEvent) {
          const target = event.target;
          if (target !== source && target !== document.body && target !== document.documentElement)
            request.moved = true;
        },
      };
      document.addEventListener('focusin', request.onFocusIn, true);
      pending.current = request;
    },
  };
}
