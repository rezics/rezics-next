import { QueryClientContext } from '@tanstack/react-query';
import { useContext, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { useLibraryApplication } from './application';

/** Each archive section owns its visit; the application supplies only current reader evidence. */
export function useRecoveryLifetime(address: string, locale: string) {
  const application = useLibraryApplication();
  const client = useContext(QueryClientContext);
  const observer = useMemo(() => application.recoveryObservation(client), [application, client]);
  const retained = useRef<{ identity: object; retire: () => void } | null>(null);
  const observation = useSyncExternalStore(
    (notify) =>
      observer.subscribe(() => {
        const next = observer.read();
        if (retained.current?.identity !== next.identity) retained.current?.retire();
        notify();
      }),
    observer.read,
    observer.read,
  );
  const scope = useMemo(() => {
    retained.current?.retire();
    let active = true;
    let mounted = false;
    const listeners = new Set<() => void>();
    const retire = () => {
      if (!active) return;
      active = false;
      listeners.forEach((listener) => listener());
      listeners.clear();
    };
    const value = {
      subject: observation.subject,
      csrfToken: observation.csrfToken,
      identity: observation.identity,
      address,
      locale,
      retire,
      mount: () => {
        mounted = true;
        return () => {
          mounted = false;
        };
      },
      current: () => {
        if (observer.read().identity !== observation.identity) retire();
        return active && mounted && !!observation.subject && !!observation.csrfToken;
      },
      onRetire: (listener: () => void) => {
        if (!active) listener();
        else listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    };
    retained.current = value;
    return value;
  }, [observation, address, locale, observer]);
  useLayoutEffect(() => scope.mount(), [scope]);
  return scope;
}
