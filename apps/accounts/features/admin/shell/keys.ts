'use client';

import { useEffect, useRef } from 'react';

/** Typing targets keep their keys; single-key shortcuts never fire inside them. */
export function isEditable(target: EventTarget | null): boolean {
  return target instanceof HTMLElement
    && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));
}

/** A key pressed on the page itself: not while an IME composes, not with a
 * modifier, not in a text field and not while a dialog is open. */
function isPageKey(event: KeyboardEvent): boolean {
  return !event.isComposing && !event.defaultPrevented && !event.metaKey && !event.ctrlKey && !event.altKey
    && !isEditable(event.target) && !document.querySelector('[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]');
}

/** Listens for page keys while mounted; the handler returns true when it used the key. */
export function usePageKeys(handler: (event: KeyboardEvent) => boolean) {
  const current = useRef(handler);
  useEffect(() => { current.current = handler; });
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (isPageKey(event) && current.current(event)) event.preventDefault();
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, []);
}

export const isMac = () => typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
