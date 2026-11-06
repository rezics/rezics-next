import { createContext, useContext } from 'react';
import { sessionCsrfToken } from '../../session/query';
import type {
  BangumiImportPort,
  BangumiTagPageResult,
} from './contract';

export const BangumiImportPortContext = createContext<BangumiImportPort | null>(null);

const productionPort: BangumiImportPort = {
  async preview(command) {
    const { previewBangumiImport } = await import('./server');
    return previewBangumiImport({ data: command, headers: { 'X-CSRF-Token': sessionCsrfToken() ?? '' } });
  },
  async page(command) {
    const { readBangumiImportPage } = await import('./server');
    return readBangumiImportPage({ data: command });
  },
  async review(command) {
    const { reviewBangumiImport } = await import('./server');
    return reviewBangumiImport({ data: command, headers: { 'X-CSRF-Token': sessionCsrfToken() ?? '' } });
  },
  async apply(command) {
    const { applyBangumiImport } = await import('./server');
    return applyBangumiImport({ data: command, headers: { 'X-CSRF-Token': sessionCsrfToken() ?? '' } });
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
  async inspect(command) {
    const { inspectBangumiCurrentFacts } = await import('./server');
    return inspectBangumiCurrentFacts({ data: command });
  },
  async cancel(command) {
    const { cancelBangumiImport } = await import('./server');
    return cancelBangumiImport({ data: command, headers: { 'X-CSRF-Token': sessionCsrfToken() ?? '' } });
  },
  async delete(command) {
    const { deleteBangumiImport } = await import('./server');
    return deleteBangumiImport({ data: command, headers: { 'X-CSRF-Token': sessionCsrfToken() ?? '' } });
  },
  async tags(command): Promise<BangumiTagPageResult> {
    const { readBangumiTags } = await import('./server');
    return readBangumiTags({ data: command });
  },
  async searchLabels(query) {
    const { searchBangumiLabels } = await import('./server');
    return searchBangumiLabels({ data: { query } });
  },
  async reviewLabels(command) {
    const { reviewBangumiLabels } = await import('./server');
    return reviewBangumiLabels({ data: command, headers: { 'X-CSRF-Token': sessionCsrfToken() ?? '' } });
  },
  async applyLabels(command) {
    const { applyBangumiLabels } = await import('./server');
    return applyBangumiLabels({ data: command, headers: { 'X-CSRF-Token': sessionCsrfToken() ?? '' } });
  },
  async readAssignments(subjectId) {
    const { readBangumiLabelAssignments } = await import('./server');
    return readBangumiLabelAssignments({ data: { subjectId } });
  },
};

export function useBangumiImportPort(): BangumiImportPort {
  return useContext(BangumiImportPortContext) ?? productionPort;
}
