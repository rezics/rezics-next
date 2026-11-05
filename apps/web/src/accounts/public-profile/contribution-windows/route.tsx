import { useEffect, createContext, useContext, type ReactNode } from 'react';
import { useRouter } from '@tanstack/react-router';
import { cancelContributionWindowFocus } from './state';

export type ContributionWindowRoute = {
  pathname: string;
  search: string;
  hash: string;
  retry: () => void;
};

const ContributionWindowRouteContext = createContext<ContributionWindowRoute | null>(null);

export function ContributionWindowRouteScope({
  route,
  children,
}: {
  route: ContributionWindowRoute | null;
  children: ReactNode;
}) {
  const router = useRouter();
  useEffect(() => {
    if (!route) return;
    return router.subscribe('onBeforeNavigate', ({ toLocation }) => {
      if (toLocation.pathname !== route.pathname) cancelContributionWindowFocus();
    });
  }, [route?.pathname, router]);

  return <ContributionWindowRouteContext.Provider value={route}>{children}</ContributionWindowRouteContext.Provider>;
}

export function useContributionWindowRoute(): ContributionWindowRoute | null {
  return useContext(ContributionWindowRouteContext);
}
