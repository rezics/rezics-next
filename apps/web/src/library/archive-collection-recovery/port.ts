import { createContext, useContext } from 'react';
import { sessionCsrfToken } from '../../session/query';
import type { RecoveryEffectCommand, RecoveryPort } from './contract';

export const ArchiveCollectionRecoveryPortContext = createContext<RecoveryPort | null>(null);

const productionPort: RecoveryPort = {
  async upload(command) {
    const { uploadArchiveCollectionRecovery } = await import('./server');
    return uploadArchiveCollectionRecovery({
      data: { key: command.key, archiveBase64: command.body.archiveBase64 },
      headers: { 'X-CSRF-Token': sessionCsrfToken() ?? '' },
    });
  },
  async status(uploadId) {
    const { readArchiveCollectionRecovery } = await import('./server');
    return readArchiveCollectionRecovery({ data: { uploadId } });
  },
  async collections(uploadId, query) {
    const { readArchiveRecoveryCollections } = await import('./server');
    return readArchiveRecoveryCollections({ data: { uploadId, ...query } });
  },
  async occurrences(uploadId, collectionId, query) {
    const { readArchiveRecoveryOccurrences } = await import('./server');
    return readArchiveRecoveryOccurrences({ data: { uploadId, collectionId, ...query } });
  },
  async review(command) {
    const { reviewArchiveCollectionRecovery } = await import('./server');
    return reviewArchiveCollectionRecovery({
      data: { uploadId: command.uploadId, key: command.key, ...command.body },
      headers: { 'X-CSRF-Token': sessionCsrfToken() ?? '' },
    });
  },
  async apply(command) {
    const { applyArchiveCollectionRecovery } = await import('./server');
    return applyArchiveCollectionRecovery({
      data: { uploadId: command.uploadId, ...command.body },
      headers: { 'X-CSRF-Token': sessionCsrfToken() ?? '' },
    });
  },
  async outcomes(uploadId, query) {
    const { readArchiveCollectionRecoveryOutcomes } = await import('./server');
    return readArchiveCollectionRecoveryOutcomes({ data: { uploadId, ...query } });
  },
  async cancel(command) {
    const { cancelArchiveCollectionRecovery } = await import('./server');
    return cancelArchiveCollectionRecovery({
      data: { uploadId: command.uploadId },
      headers: { 'X-CSRF-Token': sessionCsrfToken() ?? '' },
    });
  },
};

export function useArchiveCollectionRecoveryPort(): RecoveryPort {
  return useContext(ArchiveCollectionRecoveryPortContext) ?? productionPort;
}

export type { RecoveryEffectCommand };
