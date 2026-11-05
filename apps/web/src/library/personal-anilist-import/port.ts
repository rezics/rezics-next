import { createContext, useContext } from 'react';
import { sessionCsrfToken } from '../../session/query';
import type { AniListImportPort } from './contract';

export const AniListImportPortContext = createContext<AniListImportPort | null>(null);

const productionPort: AniListImportPort = {
  async preview(command) {
    const { previewAniListImport } = await import('./server');
    return previewAniListImport({ data: command, headers: { 'X-CSRF-Token': sessionCsrfToken() ?? '' } });
  },
  async page(command) {
    const { readAniListImportPage } = await import('./server');
    return readAniListImportPage({ data: command });
  },
  async review(command) {
    const { reviewAniListImport } = await import('./server');
    return reviewAniListImport({ data: command, headers: { 'X-CSRF-Token': sessionCsrfToken() ?? '' } });
  },
  async apply(command) {
    const { applyAniListImport } = await import('./server');
    return applyAniListImport({ data: command, headers: { 'X-CSRF-Token': sessionCsrfToken() ?? '' } });
  },
  async admitSource(command) {
    const { admitPrivateSourceForSubject, readPrivateEntryForSubject } = await import('../rich-private-entry/server');
    const { mapSourceAdmissionPort } = await import('../rich-private-entry/admission');
    let custody = command.custody;
    if (!custody) {
      const read = await readPrivateEntryForSubject({ data: { subjectId: command.subjectId } });
      if (read.kind !== 'ready') return mapSourceAdmissionPort(read, command);
      custody = { viewer: read.viewer, csrfToken: read.csrfToken, credential: read.credential };
    }
    const retryCommand = { ...command, custody };
    const result = await admitPrivateSourceForSubject({
      data: {
        subjectId: command.subjectId,
        key: command.key,
        confirmReviewed: true,
        provider: command.body.provider,
        recordId: command.body.recordId,
        privacy: command.body.privacy,
        sourceCreated: command.body.sourceCreated,
        sourceUpdated: command.body.sourceUpdated,
        viewer: custody.viewer,
        csrfToken: custody.csrfToken,
        credential: custody.credential,
      },
      headers: { 'X-CSRF-Token': sessionCsrfToken() ?? '' },
    });
    return mapSourceAdmissionPort(result, retryCommand);
  },
  async cancel(command) {
    const { cancelAniListImport } = await import('./server');
    return cancelAniListImport({ data: command, headers: { 'X-CSRF-Token': sessionCsrfToken() ?? '' } });
  },
  async question() {
    const { readAniListStandardQuestion } = await import('./server');
    return readAniListStandardQuestion({});
  },
};

export function useAniListImportPort(): AniListImportPort {
  return useContext(AniListImportPortContext) ?? productionPort;
}
