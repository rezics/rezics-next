import { createContext, useContext, useMemo, type ReactNode } from 'react';
import type { RecentSearchHost, RecentSearchTransport } from './recent-contract';
import {
  createRecentSearchSyncAdapter,
  type RecentSearchSyncAdapter,
  type RecentSearchSyncOptions,
} from './recent-sync';

export type { RecentSearchHost, RecentSearchTransport, RecentSessionView } from './recent-contract';
export { recentSearchSessionKey } from './recent-contract';

export type RecentSearchOperation = {
  host: RecentSearchHost;
  createSyncAdapter(
    options: Omit<RecentSearchSyncOptions, 'transport' | 'now' | 'createId'> & {
      transport?: RecentSearchTransport;
    },
  ): RecentSearchSyncAdapter;
};

const RecentSearchOperationContext = createContext<RecentSearchOperation | null>(null);

/** Construct the Recent Search application once for this mounted host. Nested calls use this instance. */
export function createRecentSearchOperation(host: RecentSearchHost): RecentSearchOperation {
  return {
    host,
    createSyncAdapter(options) {
      return createRecentSearchSyncAdapter({
        ...options,
        transport: options.transport ?? host.transport,
        now: host.now,
        createId: host.createId,
      });
    },
  };
}

export function RecentSearchHostBoundary({ host, children }: { host: RecentSearchHost; children: ReactNode }) {
  const operation = useMemo(() => createRecentSearchOperation(host), [host]);
  return <RecentSearchOperationContext.Provider value={operation}>{children}</RecentSearchOperationContext.Provider>;
}

export function useRecentSearchOperation(): RecentSearchOperation {
  const operation = useContext(RecentSearchOperationContext);
  if (!operation) throw new Error('Recent Search requires a mounted host');
  return operation;
}
