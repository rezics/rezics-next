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
