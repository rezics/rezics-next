import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';

export type HeaderSearchFilterRegion = {
  activeCount: number;
  open(): void;
};

type Registration = {
  owner: object;
  region: HeaderSearchFilterRegion;
};

type HeaderSearchFilterContextValue = {
  region: HeaderSearchFilterRegion | null;
  register(owner: object, region: HeaderSearchFilterRegion | null): () => void;
};

const HeaderSearchFilterContext = createContext<HeaderSearchFilterContextValue | null>(null);

/** Connect the single header Filters action to the route's existing filter controls. */
export function HeaderSearchFilterProvider({ children }: { children: ReactNode }) {
  const [registration, setRegistration] = useState<Registration | null>(null);
  const current = useRef<Registration | null>(null);
  const register = useCallback((owner: object, region: HeaderSearchFilterRegion | null) => {
    if (!region) {
      if (current.current?.owner === owner) {
        current.current = null;
        setRegistration(null);
      }
      return () => undefined;
    }

    const next = { owner, region };
    current.current = next;
    setRegistration(next);
    return () => {
      if (current.current?.owner === owner) {
        current.current = null;
        setRegistration(null);
      }
    };
  }, []);

  return (
    <HeaderSearchFilterContext.Provider value={{ region: registration?.region ?? null, register }}>
      {children}
    </HeaderSearchFilterContext.Provider>
  );
}

/** Register the route's actual current filter surface with the shared header owner. */
export function useRegisterHeaderSearchFilters(available: boolean, region: HeaderSearchFilterRegion) {
  const context = useContext(HeaderSearchFilterContext);
  const owner = useRef<object>({});
  useEffect(() => {
    if (!context) return;
    return context.register(owner.current, available ? region : null);
  }, [available, context, region]);
}

export function useHeaderSearchFilterRegion(): HeaderSearchFilterRegion | null {
  return useContext(HeaderSearchFilterContext)?.region ?? null;
}
