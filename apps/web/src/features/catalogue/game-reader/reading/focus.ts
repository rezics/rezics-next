import { useEffect, useRef, type MouseEvent } from 'react';

/** A local keyboard intent expires on any later pointer, key or moved focus. */
export function useReaderFocus(current: () => boolean, heading: () => void) {
  const revision = useRef(0);
  const origin = useRef<{ target: HTMLAnchorElement; revision: number } | undefined>(undefined);
  useEffect(() => {
    const moved = () => {
      revision.current++;
      origin.current = undefined;
    };
    const restore = () => {
      const saved = origin.current;
      origin.current = undefined;
      if (!saved || !current() || saved.revision !== revision.current) return;
      if (document.activeElement !== saved.target && document.activeElement !== document.body) return;
      if (saved.target.isConnected) saved.target.focus();
      else heading();
    };
    document.addEventListener('pointerdown', moved, true);
    document.addEventListener('keydown', moved, true);
    document.addEventListener('focusin', moved, true);
    window.addEventListener('focus', restore);
    return () => {
      document.removeEventListener('pointerdown', moved, true);
      document.removeEventListener('keydown', moved, true);
      document.removeEventListener('focusin', moved, true);
      window.removeEventListener('focus', restore);
      origin.current = undefined;
    };
  }, [current, heading]);
  return {
    clearDestination() {
      origin.current = undefined;
    },
    navigate(event: MouseEvent<HTMLAnchorElement>) {
      if (!current()) {
        event.preventDefault();
        return;
      }
      if (event.detail === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey)
        origin.current = { target: event.currentTarget, revision: revision.current };
    },
    async request(event: MouseEvent<HTMLButtonElement>, operation: () => Promise<boolean>) {
      const target = event.currentTarget;
      const keyboard = event.detail === 0;
      const intent = revision.current;
      const completed = await operation();
      if (
        completed &&
        keyboard &&
        current() &&
        intent === revision.current &&
        (document.activeElement === target || (!target.isConnected && document.activeElement === document.body))
      )
        heading();
    },
  };
}
