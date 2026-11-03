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
  async cancel(command) {
    const { cancelAniListImport } = await import('./server');
    return cancelAniListImport({ data: command, headers: { 'X-CSRF-Token': sessionCsrfToken() ?? '' } });
  },
};

export function useAniListImportPort(): AniListImportPort {
  return useContext(AniListImportPortContext) ?? productionPort;
}
