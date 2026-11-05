import { createContext, useContext } from 'react';
import { sessionCsrfToken } from '../../session/query';
import type { ExportPort } from './contract';

export const LibraryExportPortContext = createContext<ExportPort | null>(null);

const productionPort: ExportPort = {
  async create(command) {
    const { createLibraryExport } = await import('./server');
    return createLibraryExport({ data: command, headers: { 'X-CSRF-Token': sessionCsrfToken() ?? '' } });
  },
  async status(command) {
    const { readLibraryExport } = await import('./server');
    return readLibraryExport({ data: command });
  },
  async page(command) {
    const { readLibraryExportPage } = await import('./server');
    return readLibraryExportPage({ data: command });
  },
  async cancel(command) {
    const { cancelLibraryExport } = await import('./server');
    return cancelLibraryExport({ data: command, headers: { 'X-CSRF-Token': sessionCsrfToken() ?? '' } });
  },
};

export function useLibraryExportPort(): ExportPort {
  return useContext(LibraryExportPortContext) ?? productionPort;
}
