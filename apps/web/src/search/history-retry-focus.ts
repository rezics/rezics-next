import { useEffect, useLayoutEffect as useBrowserLayoutEffect, useRef, type RefObject } from 'react';
import type { RecentHistoryOwner } from './recent-history';

const useFocusLayoutEffect = typeof document === 'undefined' ? useEffect : useBrowserLayoutEffect;

/** Recover a focused history Reload onto a surviving current action or the named Recent region. */
export function useHistoryRetryFocus(
  regionRef: RefObject<HTMLElement | null>,
  owner: RecentHistoryOwner | undefined,
  pending: boolean,
  phase: unknown,
) {
  const reloadRef = useRef<HTMLButtonElement | null>(null);
  const observedOwner = useRef(owner);
  const current = useRef<{
    source: HTMLButtonElement;
    owner: RecentHistoryOwner | undefined;
    moved: boolean;
    document: Document;
    onFocusIn: (event: FocusEvent) => void;
  } | null>(null);

  function clear() {
    const request = current.current;
    if (!request) return;
    request.document.removeEventListener('focusin', request.onFocusIn, true);
    current.current = null;
  }

  useEffect(() => () => clear(), []);
  useFocusLayoutEffect(() => {
    if (observedOwner.current !== owner) {
      observedOwner.current = owner;
      clear();
      return;
    }
    const request = current.current;
    if (!request) return;
    if (request.owner !== owner || request.owner?.() === false) {
      clear();
      return;
    }
    if (pending) return;
    const { source, moved, document } = request;
    clear();
    if (moved) return;
    const active = document.activeElement;
    if (active !== source && active !== document.body && active !== document.documentElement) return;
    const target = reloadRef.current ?? regionRef.current;
    if (target?.isConnected) target.focus();
  }, [owner, pending, phase, regionRef]);

  return {
    reloadRef,
    requestReloadFocus(source: HTMLButtonElement) {
      if (source.ownerDocument.activeElement !== source) return;
      if (owner?.() === false) {
        clear();
        return;
      }
      clear();
      const document = source.ownerDocument;
      const request = {
        source,
        owner,
        moved: false,
        document,
        onFocusIn(event: FocusEvent) {
          const target = event.target;
          if (target !== source && target !== document.body && target !== document.documentElement)
            request.moved = true;
        },
      };
      document.addEventListener('focusin', request.onFocusIn, true);
      current.current = request;
    },
  };
}
