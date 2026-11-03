import { createContext, useContext, useMemo } from 'react';
import type { VndbPort } from './contract';
import {
  applyVndbImport,
  cancelVndbImport,
  deleteVndbImport,
  previewVndbImport,
  readVndbImportPage,
  readVndbImportSource,
  reviewVndbImport,
} from './server';
import type { VndbVisit } from './visit';

function serverPort(visit: VndbVisit): VndbPort {
  const data = { sender: visit.subject };
  const headers = { 'X-CSRF-Token': visit.csrfToken };
  return {
    preview: (command) => previewVndbImport({ data: { ...data, xml: command.xml, key: command.key }, headers }),
    page: (command) => readVndbImportPage({ data: { ...data, uploadId: command.uploadId, offset: command.offset } }),
    source: (command) => readVndbImportSource({ data: { ...data, uploadId: command.uploadId } }),
    review: (command) => reviewVndbImport({
      data: { ...data, uploadId: command.uploadId, key: command.key, body: command.body }, headers,
    }),
    apply: (command) => applyVndbImport({ data: { ...data, uploadId: command.uploadId, body: command.body }, headers }),
    cancel: (command) => cancelVndbImport({ data: { ...data, uploadId: command.uploadId, key: command.key }, headers }),
    delete: (command) => deleteVndbImport({ data: { ...data, uploadId: command.uploadId, key: command.key }, headers }),
  };
}

export const VndbImportPortContext = createContext<VndbPort | null>(null);

export function useVndbImportPort(visit: VndbVisit): VndbPort {
  const supplied = useContext(VndbImportPortContext);
  return useMemo(() => supplied ?? serverPort(visit), [supplied, visit]);
}
