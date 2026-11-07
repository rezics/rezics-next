import type { QueryClient } from '@tanstack/react-query';
import { browserObservation } from './observation';
import { viewerExposureLifetime, viewerExposureQuery } from '../kernel/viewer-exposure';
import { exposureQuery } from './query';
import { sessionQuery, useSession } from './index';
import type { RecoveryObserver, RecoveryObservation } from '../library/application';
import { LibraryPrivateLifetime } from '../library/private-lifetime';
import { SearchLibraryActionBinding } from '../library/search-action-binding';
import type { ReactNode } from 'react';
import { LibraryApplicationContext, type LibraryApplication } from '../library/application';
import {
  useOperation,
  useOperationAdmission,
  useWorkspaceAdmission,
  useReaderCurrentOrigin,
  useReaderAddress,
  useReaderResponseOrigin,
} from './reader';

/** Bind the existing producers. This adapter owns no session, query cache or admission state. */
export const libraryApplication: LibraryApplication = {
  recoveryObservation,
  useSession,
  useOperation,
  useOperationAdmission,
  useWorkspaceAdmission,
  useReaderCurrentOrigin,
  useReaderAddress,
  useReaderResponseOrigin,
};

export function LibraryApplicationBoundary({ children }: { children: ReactNode }) {
  return (
    <LibraryApplicationContext value={libraryApplication}>
      <SearchLibraryActionBinding>
        <LibraryPrivateLifetime>{children}</LibraryPrivateLifetime>
      </SearchLibraryActionBinding>
    </LibraryApplicationContext>
  );
}

/** Observe the actual producer incarnations, including equal-value replacement and A/B/A updates. */
function recoveryObservation(client: QueryClient | undefined): RecoveryObserver {
  let signature: readonly unknown[] = [];
  let snapshot: RecoveryObservation = { subject: null, csrfToken: null, identity: {} };
  const read = () => {
    const session = client?.getQueryState(sessionQuery.queryKey);
    const exposure = client?.getQueryState(exposureQuery.queryKey);
    const viewer = client && viewerExposureLifetime(client).getSnapshot();
    const scopedKey = viewerExposureQuery(viewer?.state === 'signed-in' ? viewer.observation : undefined).queryKey;
    const scoped = client?.getQueryState(scopedKey);
    const next = [
      client?.getQueryCache().find({ queryKey: sessionQuery.queryKey, exact: true }),
      session?.status,
      session?.dataUpdateCount,
      session?.data,
      client?.getQueryCache().find({ queryKey: exposureQuery.queryKey, exact: true }),
      exposure?.status,
      exposure?.dataUpdateCount,
      exposure?.data,
      viewer,
      client?.getQueryCache().find({ queryKey: scopedKey, exact: true }),
      scoped?.status,
      scoped?.dataUpdateCount,
      scoped?.data,
    ];
    if (next.some((value, index) => value !== signature[index])) {
      signature = next;
      const data = session?.status === 'success' ? session.data : undefined;
      snapshot = {
        subject: data?.state === 'signed-in' ? (data.subject ?? null) : null,
        csrfToken: data?.state === 'signed-in' ? data.csrfToken : null,
        identity: {},
      };
    }
    return snapshot;
  };
  return {
    read,
    subscribe: (notify) => {
      if (!client) return () => {};
      const stopCache = browserObservation(client).subscribeCache(notify);
      const stopViewer = viewerExposureLifetime(client).subscribe(notify);
      return () => {
        stopCache();
        stopViewer();
      };
    },
  };
}

export { workspaceAdmission } from '../reader/workspace-admission';
