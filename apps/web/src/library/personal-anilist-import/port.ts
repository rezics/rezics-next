import { createContext, useContext } from 'react';
import { sessionCsrfToken } from '../../session';
import { archiveTransportLost } from '../archive-entry-recovery/native';
import type { AniListCommand, AniListImportPort } from './contract';

export const AniListImportPortContext = createContext<AniListImportPort | null>(null);

async function labelDelivery<T>(command: AniListCommand, send: () => Promise<T>) {
  try {
    return await send();
  } catch (error) {
    if (archiveTransportLost(error)) return { kind: 'unknown' as const, command };
    throw error;
  }
}

const productionPort: AniListImportPort = {
  async reviewLabels(command) {
    const { captureAniListLabelSender, reviewAniListLabels } = await import('./server');
    const headers = { 'X-CSRF-Token': sessionCsrfToken() ?? '' };
    if (command.custody.sender === undefined) {
      const captured = await captureAniListLabelSender({ data: command.custody, headers });
      if (captured !== undefined) command.custody.sender = captured;
    }
    return labelDelivery(command, () => reviewAniListLabels({ data: command, headers }));
  },
  async applyLabels(command) {
    const { captureAniListLabelSender, applyAniListLabels } = await import('./server');
    const headers = { 'X-CSRF-Token': sessionCsrfToken() ?? '' };
    if (command.custody.sender === undefined) {
      const captured = await captureAniListLabelSender({ data: command.custody, headers });
      if (captured !== undefined) command.custody.sender = captured;
    }
    return labelDelivery(command, () => applyAniListLabels({ data: command, headers }));
  },
  async readLabels(command) {
    const { readAniListLabels } = await import('./server');
    return readAniListLabels({ data: command });
  },
  async labelTargets(query, cursor, custody) {
    const { searchAniListLabelTargets } = await import('./server');
    return searchAniListLabelTargets({ data: { query, custody, ...(cursor === undefined ? {} : { cursor }) } });
  },
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
