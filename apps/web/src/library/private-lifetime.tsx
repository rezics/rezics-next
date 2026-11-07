import { useQueryClient } from '@tanstack/react-query';
import { useLayoutEffect, useMemo, type ReactNode } from 'react';
import { useLibraryApplication } from './application';
import { bindArchiveCustodyOwner } from './private-export/custody';

/** Completed archive bytes belong to the actual application reader, across ordinary route changes. */
export function LibraryPrivateLifetime({ children }: { children: ReactNode }) {
  const application = useLibraryApplication();
  const client = useQueryClient();
  const observer = useMemo(() => application.recoveryObservation(client), [application, client]);
  useLayoutEffect(() => {
    const observe = () => bindArchiveCustodyOwner(observer.read().subject ?? '');
    const stop = observer.subscribe(observe);
    observe();
    return stop;
  }, [observer]);
  return children;
}
