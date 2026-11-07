import { useLayoutEffect, useMemo, type ReactNode } from 'react';
import { useRouter } from '@tanstack/react-router';
import { ReaderNavigationContext } from '../reader/lifetime/index';
import type { ReaderNavigation } from '../reader/lifetime/contract';

/** One application session host. QueryClient remains the sole session source. */
export function SessionProvider({ children }: { children: ReactNode }) {
  const router = useRouter({ warn: false });
  const host = useMemo(() => {
    if (!router) return undefined;
    let address = router.latestLocation.href;
    const listeners = new Set<() => void>();
    const navigation: ReaderNavigation = {
      address: () => address,
      subscribe(changed) {
        listeners.add(changed);
        return () => {
          listeners.delete(changed);
        };
      },
    };
    return {
      navigation,
      mount: () => {
        address = router.latestLocation.href;
        return router.subscribe('onBeforeNavigate', ({ toLocation }) => {
          address = toLocation.href;
          for (const changed of [...listeners]) changed();
        });
      },
    };
  }, [router]);
  useLayoutEffect(() => host?.mount(), [host]);
  return <ReaderNavigationContext.Provider value={host?.navigation}>{children}</ReaderNavigationContext.Provider>;
}
