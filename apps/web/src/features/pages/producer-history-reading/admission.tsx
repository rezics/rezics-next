import { useCallback, useMemo, useSyncExternalStore, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { browserObservation } from '../../../session';
import { CandidateReaderBoundary, useCatalogueLifetime } from '../../../subject/candidate-lifetime';
import type { useSession } from '../../../session/query';

/** Exposure replacement retires the visit through the existing observation store.
 * The synchronous predicate fences callbacks before React publishes the new mount.
 */
export function ProducerHistoryAdmission({
  observed,
  address,
  children,
}: {
  observed: ReturnType<typeof useSession>;
  address: string;
  children: ReactNode;
}) {
  const client = useQueryClient();
  const store = browserObservation(client);
  const parent = useCatalogueLifetime('producer-exposure');
  const snapshot = useCallback(
    () =>
      JSON.stringify(
        client
          .getQueryCache()
          .findAll({ queryKey: ['exposure', 'viewer'] })
          .map((query) => [
            query.queryHash,
            query.state.status,
            query.state.fetchStatus,
            query.state.isInvalidated,
            query.state.dataUpdateCount,
            query.state.errorUpdateCount,
          ]),
      ),
    [client],
  );
  const exposure = useSyncExternalStore(store.subscribeCache, snapshot, snapshot);
  const admission = useMemo(
    () => ({
      reader: parent.reader,
      live: () => parent.active() && snapshot() === exposure,
    }),
    [parent, snapshot, exposure],
  );
  return (
    <CandidateReaderBoundary observed={observed} admission={admission} address={address}>
      {children}
    </CandidateReaderBoundary>
  );
}
