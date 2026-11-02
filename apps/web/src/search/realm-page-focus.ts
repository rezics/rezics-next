import { useEffect, useLayoutEffect as useBrowserLayoutEffect, useRef, type RefObject } from 'react';

const useFocusLayoutEffect = typeof document === 'undefined' ? useEffect : useBrowserLayoutEffect;

function actionButton(target: EventTarget | null): HTMLButtonElement | null {
  const element = target instanceof Element ? target : target instanceof Node ? target.parentElement : null;
  return element?.closest('button') ?? null;
}

function recoverTarget(root: HTMLElement | null, source: HTMLButtonElement): HTMLElement | null {
  if (!root) return null;
  if (source.isConnected && !source.disabled) return source;
  const label = source.textContent;
  for (const button of root.querySelectorAll('button')) {
    if (!button.disabled && button.isConnected && button.textContent === label) return button;
  }
  const region = root.querySelector<HTMLElement>('[data-slot="realm-discovery"]');
  if (!region) return null;
  if (!region.hasAttribute('tabindex')) region.tabIndex = -1;
  return region;
}

/** Recover a focused Realm Retry or terminal More onto a surviving current action or the named discovery region. */
export function useRealmPageFocus(owner: object, pending: boolean, phase: unknown) {
  const rootRef = useRef<HTMLElement | null>(null);
  const observedOwner = useRef(owner);
  const current = useRef<{
    source: HTMLButtonElement;
    owner: object;
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
    if (request.owner !== owner) {
      clear();
      return;
    }
    if (pending) return;
    const { source, moved, document } = request;
    clear();
    if (moved) return;
    const active = document.activeElement;
    if (active !== source && active !== document.body && active !== document.documentElement) return;
    const target = recoverTarget(rootRef.current, source);
    if (target?.isConnected) target.focus();
  }, [owner, pending, phase]);

  return {
    rootRef: rootRef as RefObject<HTMLDivElement | null>,
    captureActivation(event: { target: EventTarget | null }) {
      const source = actionButton(event.target);
      if (!source || source.disabled || source.ownerDocument.activeElement !== source) return;
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
