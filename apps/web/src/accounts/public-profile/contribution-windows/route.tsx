import { createContext, useContext, type ReactNode } from 'react';

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
  return <ContributionWindowRouteContext.Provider value={route}>{children}</ContributionWindowRouteContext.Provider>;
}

export function useContributionWindowRoute(): ContributionWindowRoute | null {
  return useContext(ContributionWindowRouteContext);
}
