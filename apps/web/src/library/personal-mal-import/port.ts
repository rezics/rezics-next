import { createContext, useContext } from 'react';
import { sessionCsrfToken } from '../../session/query';
import type { MalImportPort } from './contract';

export const MalImportPortContext = createContext<MalImportPort | null>(null);

const productionPort: MalImportPort = {
  async preview(command) {
    const { previewMalImport } = await import('./server');
    return previewMalImport({ data: command, headers: { 'X-CSRF-Token': sessionCsrfToken() ?? '' } });
  },
  async page(command) {
    const { readMalImportPage } = await import('./server');
    return readMalImportPage({ data: command });
  },
  async review(command) {
    const { reviewMalImport } = await import('./server');
    return reviewMalImport({ data: command, headers: { 'X-CSRF-Token': sessionCsrfToken() ?? '' } });
  },
  async apply(command) {
    const { applyMalImport } = await import('./server');
    return applyMalImport({ data: command, headers: { 'X-CSRF-Token': sessionCsrfToken() ?? '' } });
  },
  async admitSource(command) {
    const { admitPrivateSourceForSubject } = await import('../rich-private-entry/server');
    const { mapSourceAdmissionPort } = await import('../rich-private-entry/admission');
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
      },
      headers: { 'X-CSRF-Token': sessionCsrfToken() ?? '' },
    });
    return mapSourceAdmissionPort(result, command);
  },
  async cancel(command) {
    const { cancelMalImport } = await import('./server');
    return cancelMalImport({ data: command, headers: { 'X-CSRF-Token': sessionCsrfToken() ?? '' } });
  },
  async delete(command) {
    const { deleteMalImport } = await import('./server');
    return deleteMalImport({ data: command, headers: { 'X-CSRF-Token': sessionCsrfToken() ?? '' } });
  },
};

export function useMalImportPort(): MalImportPort {
  return useContext(MalImportPortContext) ?? productionPort;
}
