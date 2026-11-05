import { createContext, useCallback, useContext, useMemo, type ReactNode } from 'react';
import { isNotFound, useRouter, useRouterState } from '@tanstack/react-router';
import { getLocale, locales } from '../../paraglide/runtime.js';
import type { Locale, LocaleNavigationLocation } from './routing';

type RouterSnapshot = {
  location: {
    pathname: string;
    searchStr: string;
    hash: string;
    href: string;
    state: unknown;
  };
  matches: readonly {
    routeId: string;
    status: string;
    error?: unknown;
    _notFound?: boolean;
  }[];
};

export type LocaleNavigationContextValue = Readonly<{
  location: LocaleNavigationLocation;
  readCurrentLocation: () => LocaleNavigationLocation;
  navigate: (href: string) => Promise<LocaleNavigationLocation>;
  revalidate: () => Promise<void>;
  commitLocale?: (locale: Locale) => Promise<void> | void;
}>;

const LocaleNavigationContext = createContext<LocaleNavigationContextValue | null>(null);

function readLocale(): Locale {
  const locale = getLocale();
  return locales.find((candidate) => candidate === locale) ?? 'en';
}

function routeLocation(state: RouterSnapshot): LocaleNavigationLocation {
  const notFound = state.matches.some(
    (match) => match._notFound === true || match.status === 'notFound' || isNotFound(match.error),
  );
  const recognized = state.location.pathname === '/' || state.matches.some((match) => match.routeId !== '__root__');
  const routeState = state.location.state;
  const key =
    routeState !== null && typeof routeState === 'object' && '__TSR_key' in routeState
      ? (routeState as { __TSR_key?: unknown }).__TSR_key
      : undefined;
  return {
    pathname: state.location.pathname,
    searchStr: state.location.searchStr,
    hash: state.location.hash && !state.location.hash.startsWith('#') ? `#${state.location.hash}` : state.location.hash,
    locale: readLocale(),
    visitKey: typeof key === 'string' ? key : state.location.href,
    supported: recognized && !notFound,
  };
}

function RouterLocaleNavigationProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const location = useRouterState({
    select: (state) => routeLocation(state as unknown as RouterSnapshot),
  });
  const readCurrentLocation = useCallback(() => routeLocation(router.state as unknown as RouterSnapshot), [router]);
  const navigate = useCallback(
    async (href: string) => {
      await router.navigate({ href });
      return readCurrentLocation();
    },
    [readCurrentLocation, router],
  );
  const revalidate = useCallback(() => router.invalidate(), [router]);
  const value = useMemo(
    () => ({ location, readCurrentLocation, navigate, revalidate }),
    [location, navigate, readCurrentLocation, revalidate],
  );
  return <LocaleNavigationContext.Provider value={value}>{children}</LocaleNavigationContext.Provider>;
}

export function LocaleNavigationProvider({
  children,
  value,
}: {
  children: ReactNode;
  value?: LocaleNavigationContextValue;
}) {
  return value ? (
    <LocaleNavigationContext.Provider value={value}>{children}</LocaleNavigationContext.Provider>
  ) : (
    <RouterLocaleNavigationProvider>{children}</RouterLocaleNavigationProvider>
  );
}

export function useLocaleNavigation() {
  return useContext(LocaleNavigationContext);
}
