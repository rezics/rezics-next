import { createContext, useContext, useLayoutEffect, useMemo, type ReactNode } from 'react';
import type { createConnectionWindow } from '../../pages/subject-connections-window';

type Binding = { source: object; window: ReturnType<typeof createConnectionWindow> };
function associationBridge() {
  let current: Binding | undefined;
  const listeners = new Set<() => void>();
  const publish = () => {
    for (const listener of listeners) listener();
  };
  return {
    snapshot: () => current,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    bind(binding: Binding) {
      current = binding;
      publish();
      return () => {
        if (current === binding) {
          current = undefined;
          publish();
        }
      };
    },
  };
}
export const CharacterAssociationContext = createContext<ReturnType<typeof associationBridge> | null>(null);

/** One mounted controller retains the windows; the profile is another view of that same selected evidence. */
export function CharacterAssociationBridge({ source, children }: { source: object; children: ReactNode }) {
  const bridge = useMemo(associationBridge, [source]);
  return <CharacterAssociationContext.Provider value={bridge}>{children}</CharacterAssociationContext.Provider>;
}

export function CharacterAssociationBinding({ source, window, children }: Binding & { children: ReactNode }) {
  const bridge = useContext(CharacterAssociationContext);
  useLayoutEffect(() => bridge?.bind({ source, window }), [bridge, source, window]);
  return children;
}
