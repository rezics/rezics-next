import type { ExpectedReader } from '../../session/expected-reader';
import { archiveTransportLost, type ArchiveRecoveryPort } from './native';

/** The encrypted original sender is captured before any archive command can be sent. */
export async function browserArchiveRecoveryPort(expected: ExpectedReader): Promise<ArchiveRecoveryPort> {
  const { archiveRecoverySender, archiveRecoveryCall } = await import('./server');
  const headers = { 'X-CSRF-Token': expected.expectedCredential };
  const sender = await archiveRecoverySender({ data: expected, headers });
  function call<K extends keyof ArchiveRecoveryPort>(
    operation: K,
    args: Parameters<ArchiveRecoveryPort[K]>,
  ): ReturnType<ArchiveRecoveryPort[K]> {
    const data = { ...expected, ...(sender === undefined ? {} : { sender }), operation, args } as NonNullable<
      Parameters<typeof archiveRecoveryCall>[0]
    >['data'];
    return archiveRecoveryCall({ data, headers }).catch((error) => {
      if (archiveTransportLost(error)) return { kind: 'uncertain' as const };
      throw error;
    }) as ReturnType<ArchiveRecoveryPort[K]>;
  }
  // Signals fence the mounted visit locally; they are not serialized over the server-function boundary.
  return {
    upload: (text, key) => call('upload', [text, key]),
    status: (id) => call('status', [id]),
    preview: (id, after) => call('preview', [id, after]),
    review: (id, items) => call('review', [id, items]),
    apply: (id, confirmation) => call('apply', [id, confirmation]),
    results: (id, after) => call('results', [id, after]),
    cancel: (id) => call('cancel', [id]),
    prune: (id) => call('prune', [id]),
    entry: (id) => call('entry', [id]),
    personal: (id) => call('personal', [id]),
    journal: (id) => call('journal', [id]),
    label: (id) => call('label', [id]),
  };
}
