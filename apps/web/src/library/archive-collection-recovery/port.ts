import { createContext, useContext, useMemo } from 'react';
import type { RecoveryEffectCommand, RecoveryPort, RecoveryResult } from './contract';
import type { RecoveryVisit } from './visit';

export const ArchiveCollectionRecoveryPortContext = createContext<RecoveryPort | null>(null);

type Context = {
  data: { expectedReader: string; expectedCredential: string; sender?: string };
  headers: { 'X-CSRF-Token': string };
};

function browserPort(visit: RecoveryVisit): RecoveryPort {
  const expected = { expectedReader: visit.subject, expectedCredential: visit.csrfToken };
  const headers = { 'X-CSRF-Token': expected.expectedCredential };
  let originalSender: Promise<string | undefined> | undefined;

  async function call<T>(send: (context: Context) => Promise<RecoveryResult<T>>): Promise<RecoveryResult<T>> {
    if (!visit.current()) return { kind: 'denied' };
    // A failed capture precedes dispatch. A successful one belongs to this visit, including every retry.
    originalSender ??= import('../archive-entry-recovery/server').then(({ archiveRecoverySender }) =>
      archiveRecoverySender({ data: expected, headers }),
    );
    let sender: string | undefined;
    try {
      sender = await originalSender;
    } catch {
      originalSender = undefined;
      return { kind: 'unavailable' };
    }
    if (!visit.current()) return { kind: 'denied' };
    return send({ data: { ...expected, ...(sender === undefined ? {} : { sender }) }, headers });
  }

  return {
    upload: (command) =>
      call(async ({ data, headers }) => {
        const { uploadArchiveCollectionRecovery } = await import('./server');
        return uploadArchiveCollectionRecovery({ data: { ...data, key: command.key, ...command.body }, headers });
      }),
    status: (uploadId) =>
      call(async ({ data, headers }) => {
        const { readArchiveCollectionRecovery } = await import('./server');
        return readArchiveCollectionRecovery({ data: { ...data, uploadId }, headers });
      }),
    collections: (uploadId, query) =>
      call(async ({ data, headers }) => {
        const { readArchiveRecoveryCollections } = await import('./server');
        return readArchiveRecoveryCollections({ data: { ...data, uploadId, ...query }, headers });
      }),
    occurrences: (uploadId, collectionId, query) =>
      call(async ({ data, headers }) => {
        const { readArchiveRecoveryOccurrences } = await import('./server');
        return readArchiveRecoveryOccurrences({ data: { ...data, uploadId, collectionId, ...query }, headers });
      }),
    review: (command) =>
      call(async ({ data, headers }) => {
        const { reviewArchiveCollectionRecovery } = await import('./server');
        return reviewArchiveCollectionRecovery({
          data: { ...data, uploadId: command.uploadId, key: command.key, ...command.body },
          headers,
        });
      }),
    apply: (command) =>
      call(async ({ data, headers }) => {
        const { applyArchiveCollectionRecovery } = await import('./server');
        return applyArchiveCollectionRecovery({ data: { ...data, uploadId: command.uploadId, ...command.body }, headers });
      }),
    outcomes: (uploadId, query) =>
      call(async ({ data, headers }) => {
        const { readArchiveCollectionRecoveryOutcomes } = await import('./server');
        return readArchiveCollectionRecoveryOutcomes({ data: { ...data, uploadId, ...query }, headers });
      }),
    cancel: (command) =>
      call(async ({ data, headers }) => {
        const { cancelArchiveCollectionRecovery } = await import('./server');
        return cancelArchiveCollectionRecovery({ data: { ...data, uploadId: command.uploadId }, headers });
      }),
    receivingCollection: (collectionId, cursor) =>
      call(async ({ data, headers }) => {
        const { readReceivingCollection } = await import('./server');
        return readReceivingCollection({
          data: { ...data, collectionId, ...(cursor === undefined ? {} : { cursor }) },
          headers,
        });
      }),
  };
}

export function useArchiveCollectionRecoveryPort(visit: RecoveryVisit): RecoveryPort {
  const fixture = useContext(ArchiveCollectionRecoveryPortContext);
  return useMemo(() => fixture ?? browserPort(visit), [fixture, visit]);
}

export type { RecoveryEffectCommand };
