import { useEffect, useRef } from 'react';

/** Browser history owns the cursor/address. Keep only a mounted, current focus bookmark. */
export function useFollowingReturn(
  current: () => boolean,
  suspend: () => void,
  refresh?: () => void,
  restoreFocus?: () => void,
) {
  const latest = useRef({ current, suspend, refresh, restoreFocus });
  latest.current = { current, suspend, refresh, restoreFocus };
  useEffect(() => {
    const hide = () => latest.current.suspend();
    const show = (event: PageTransitionEvent) => {
      if (event.persisted && latest.current.current()) {
        latest.current.refresh?.();
        latest.current.restoreFocus?.();
      }
    };
    window.addEventListener('pagehide', hide);
    window.addEventListener('pageshow', show);
    return () => {
      window.removeEventListener('pagehide', hide);
      window.removeEventListener('pageshow', show);
    };
  }, []);
}
