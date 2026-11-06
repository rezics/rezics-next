import { createContext, useContext } from 'react';
import { sessionCsrfToken } from '../../session/query';
import type { MalImportPort, MalPreviewResult } from './contract';

export const MalImportPortContext = createContext<MalImportPort | null>(null);

const productionPort: MalImportPort = {
  async source(id) {
    const { readMalSource } = await import('./server');
    return readMalSource({ data: { id } });
  },
  async assignments(subjectId) {
    const { readMalAssignments } = await import('./server');
    return readMalAssignments({ data: { subjectId } });
  },
  async readQuestion() {
    const { readMalImportQuestion } = await import('./server');
    return readMalImportQuestion();
  },
  async readVote(input) {
    const { readMalImportVote } = await import('./server');
    return readMalImportVote({ data: input });
  },
  async preview(command): Promise<MalPreviewResult> {
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
