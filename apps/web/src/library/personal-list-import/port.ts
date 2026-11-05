import { createContext, useContext, useMemo } from 'react';
import type { VndbCommand, VndbPort, VndbUnknown } from './contract';
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
  const endpoints: VndbPort = {
    preview: (command) => previewVndbImport({ data: { ...data, xml: command.xml, key: command.key }, headers }),
    page: (command) => readVndbImportPage({ data: { ...data, uploadId: command.uploadId, offset: command.offset } }),
    source: (command) => readVndbImportSource({ data: { ...data, uploadId: command.uploadId } }),
    review: (command) =>
      reviewVndbImport({
        data: { ...data, uploadId: command.uploadId, key: command.key, body: command.body },
        headers,
      }),
    apply: (command) => applyVndbImport({ data: { ...data, uploadId: command.uploadId, body: command.body }, headers }),
    cancel: (command) => cancelVndbImport({ data: { ...data, uploadId: command.uploadId, key: command.key }, headers }),
    delete: (command) => deleteVndbImport({ data: { ...data, uploadId: command.uploadId, key: command.key }, headers }),
  };
  // A lost browser/server-function acknowledgement retains the exact dispatched command.
  async function send<K extends keyof VndbPort>(kind: K, command: Parameters<VndbPort[K]>[0]) {
    try {
      return await (endpoints[kind] as (command: VndbCommand) => ReturnType<VndbPort[K]>)(command);
    } catch (error) {
      if (error instanceof TypeError || error instanceof DOMException || error instanceof SyntaxError)
        return { kind: 'unknown', command } satisfies VndbUnknown;
      throw error;
    }
  }
  return {
    preview: (command) => send('preview', command),
    page: (command) => send('page', command),
    source: (command) => send('source', command),
    review: (command) => send('review', command),
    apply: (command) => send('apply', command),
    cancel: (command) => send('cancel', command),
    delete: (command) => send('delete', command),
  };
}

export const VndbImportPortContext = createContext<VndbPort | null>(null);

export function useVndbImportPort(visit: VndbVisit): VndbPort {
  const supplied = useContext(VndbImportPortContext);
  return useMemo(() => supplied ?? serverPort(visit), [supplied, visit]);
}
