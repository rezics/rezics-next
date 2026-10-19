import { useLayoutEffect, useRef } from 'react';

/** Keep a refresh's recovery action reachable after its button is disabled or replaced. */
export function useRecoveryFocus(busy: boolean) {
  const target = useRef<HTMLButtonElement>(null);
  const ownedFocus = useRef(false);
  useLayoutEffect(() => {
    if (!ownedFocus.current) return;
    if (!busy) {
      ownedFocus.current = false;
      if (document.activeElement === document.body) target.current?.focus();
      return;
    }
    // A person who moves focus during the request keeps their new position.
    const moved = (event: FocusEvent) => {
      if (event.target !== target.current && event.target !== document.body) ownedFocus.current = false;
    };
    document.addEventListener('focusin', moved);
    return () => document.removeEventListener('focusin', moved);
  }, [busy]);
  return { target, remember: () => { ownedFocus.current = target.current === document.activeElement; } };
}
