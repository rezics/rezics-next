import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { addressLease, browserObservation } from '../../session';
import { useReaderAddress } from '../../session/reader';

/** Compose the installed browser observation with the public retiring address lease, including anonymous reads. */
export function useCharacterPersonReader(locale: string, request: string) {
  const client = useQueryClient();
  const observer = useMemo(() => browserObservation(client), [client]);
  const snapshot = useSyncExternalStore(observer.subscribe, observer.getSnapshot, observer.getServerSnapshot);
  const address = useReaderAddress(null, undefined, locale);
  const ready = snapshot.state === 'signed-in' || snapshot.state === 'signed-out';
  const identity = JSON.stringify([request, address.key, snapshot]);
  const mounted = useRef(true);
  const previous = useRef<ReturnType<typeof addressLease> | undefined>(undefined);
  const lease = useMemo(
    () => addressLease(() => ready && observer.getSnapshot() === snapshot && address.isCurrent()),
    [identity, observer, snapshot],
  );
  if (previous.current !== lease) previous.current?.retire();
  previous.current = lease;
  // A development effect replay is still this visit; actual unmounts close dispatch and child reads abort.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, [lease]);
  return { identity, current: () => mounted.current && lease.current(), ready };
}
