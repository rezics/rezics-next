import { useEffect, useRef } from 'react';

/** Browser history owns the cursor/address. Keep only a mounted, current focus bookmark. */
export function useFollowingReturn(current: () => boolean, close: (focus?: boolean) => void, refresh?: () => void) {
  const latest = useRef({ current, close, refresh });
  latest.current = { current, close, refresh };
  useEffect(() => {
    const hide = () => latest.current.close(false);
    const show = (event: PageTransitionEvent) => {
      if (event.persisted && latest.current.current()) latest.current.refresh?.();
    };
    window.addEventListener('pagehide', hide);
    window.addEventListener('pageshow', show);
    return () => {
      window.removeEventListener('pagehide', hide);
      window.removeEventListener('pageshow', show);
    };
  }, []);
}
