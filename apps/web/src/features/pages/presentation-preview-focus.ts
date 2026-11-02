import { useEffect, useLayoutEffect as useBrowserLayoutEffect, useRef } from 'react';
import type { PresentationPreview, PresentationPreviewInput } from './presentation-preview';

const useFocusLayoutEffect = typeof document === 'undefined' ? useEffect : useBrowserLayoutEffect;

export type PreviewCloseFocusOwner = {
  locale: string;
  read: (input: PresentationPreviewInput) => Promise<PresentationPreview>;
};

type PendingCloseFocus = {
  owner: PreviewCloseFocusOwner;
  source: HTMLButtonElement;
  moved: boolean;
};

export function previewCloseOwnerCurrent(pending: PreviewCloseFocusOwner, current: PreviewCloseFocusOwner): boolean {
  return pending.locale === current.locale && pending.read === current.read;
}

function fallbackFocus(active: Element | null, source: HTMLButtonElement, inspect: HTMLElement): boolean {
  const document = source.ownerDocument;
  return active === source || active === inspect || active === document.body || active === document.documentElement;
}

/** Restore a focused Close onto the surviving Inspect control of the same preview owner. */
export function previewCloseFocusTarget({
  pending,
  current,
  enabled,
  active,
  inspect,
}: {
  pending: PendingCloseFocus | null;
  current: PreviewCloseFocusOwner;
  enabled: boolean;
  active: Element | null;
  inspect: HTMLButtonElement | null;
}): HTMLButtonElement | null {
  if (!pending || pending.moved || !previewCloseOwnerCurrent(pending.owner, current)) return null;
  if (!enabled || !inspect?.isConnected || inspect.disabled) return null;
  if (!fallbackFocus(active, pending.source, inspect)) return null;
  return inspect;
}

export function usePreviewCloseFocus(current: PreviewCloseFocusOwner, enabled: boolean) {
  const inspectRef = useRef<HTMLButtonElement>(null);
  const ownerRef = useRef(current);
  ownerRef.current = current;
  const pending = useRef<(PendingCloseFocus & { document: Document; onFocusIn: (event: FocusEvent) => void }) | null>(
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
    if (!previewCloseOwnerCurrent(request.owner, current) || request.moved) {
      clear();
      return;
    }
    if (!enabled || inspectRef.current?.disabled) return;
    const target = previewCloseFocusTarget({
      pending: request,
      current,
      enabled: true,
      active: request.document.activeElement,
      inspect: inspectRef.current,
    });
    clear();
    target?.focus();
  }, [current.locale, current.read, enabled]);

  return {
    inspectRef,
    captureCloseFocus(source: HTMLButtonElement) {
      if (source.ownerDocument.activeElement !== source) return;
      clear();
      const document = source.ownerDocument;
      const owner = ownerRef.current;
      const request = {
        owner: { locale: owner.locale, read: owner.read },
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
