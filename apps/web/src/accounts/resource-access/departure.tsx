import { createContext, useCallback, useContext, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useAuthoringDeparture } from '../../threads/authoring-departure';

type Draft = { signature: string; changed: boolean; retire(): void };
const DraftContext = createContext<(draft: Draft) => () => void>(() => () => {});

/** Paging and editor replacement share the route's decision and retire reads before the destination acts. */
export function AccessDeparture({
  children,
  unresolved,
  retire,
  abandon,
}: {
  children: (move: (destination: () => void) => void) => ReactNode;
  unresolved: boolean;
  retire(): void;
  abandon(): void;
}) {
  const draft = useRef<Draft | null>(null);
  const [signature, setSignature] = useState('');
  const destination = useRef<(() => void) | null>(null);
  const register = useCallback((value: Draft) => {
    draft.current = value;
    setSignature(value.signature);
    return () => {
      if (draft.current === value) {
        draft.current = null;
        setSignature('');
      }
    };
  }, []);
  const departure = useAuthoringDeparture(
    () => unresolved || !!draft.current?.changed,
    unresolved,
    `${unresolved}:${signature}`,
    () => {
      draft.current?.retire();
      abandon();
      destination.current?.();
      destination.current = null;
    },
    () => {
      draft.current?.retire();
      retire();
    },
  );
  const move = (next: () => void) => {
    destination.current = next;
    departure.requestDiscard(() => {
      draft.current?.retire();
      if (unresolved) abandon();
      next();
    });
  };
  return <DraftContext.Provider value={register}>{children(move)}</DraftContext.Provider>;
}

export function useAccessDraft(signature: string, changed: boolean, retire: () => void) {
  const register = useContext(DraftContext);
  const latest = useRef(retire);
  latest.current = retire;
  useLayoutEffect(
    () => register({ signature, changed, retire: () => latest.current() }),
    [register, signature, changed],
  );
}
