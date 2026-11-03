import { useRouter } from '@tanstack/react-router';
import { useEffect, useRef } from 'react';

let refreshWhenRatingsReturns = false;

/** Leaving for a Subject invalidates the private visit; return performs one fresh page read and restores focus. */
export function useOwnVotesReturn(
  visitKey: string,
  isCurrent: () => boolean,
  refresh: () => Promise<unknown>,
  restoreFocus: () => void,
) {
  const router = useRouter({ warn: false });
  const latest = useRef({ isCurrent, refresh, restoreFocus });
  latest.current = { isCurrent, refresh, restoreFocus };

  useEffect(() => {
    const stop = router?.subscribe('onBeforeNavigate', ({ toLocation }) => {
      const to = toLocation.pathname.replace(/^\/(?:en|zh-Hant|zh-Hans|ja|ko|de|fr|es)(?=\/|$)/, '');
      if (to !== '/library/ratings') refreshWhenRatingsReturns = true;
    });
    return () => stop?.();
  }, [router]);

  useEffect(() => {
    if (!refreshWhenRatingsReturns || !latest.current.isCurrent()) return;
    refreshWhenRatingsReturns = false;
    void latest.current.refresh().then(() => {
      requestAnimationFrame(() => {
        if (latest.current.isCurrent()) latest.current.restoreFocus();
      });
    });
  }, [visitKey]);

  useEffect(() => {
    const hide = () => {
      if (latest.current.isCurrent()) refreshWhenRatingsReturns = true;
    };
    const show = (event: PageTransitionEvent) => {
      if (event.persisted && latest.current.isCurrent()) {
        refreshWhenRatingsReturns = false;
        void latest.current.refresh().then(() => {
          if (latest.current.isCurrent()) latest.current.restoreFocus();
        });
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
