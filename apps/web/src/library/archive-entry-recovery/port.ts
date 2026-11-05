import type { ExpectedReader } from '../../session/expected-reader';
import type { ArchiveRecoveryPort } from './native';

/** The encrypted original sender is captured before any archive command can be sent. */
export async function browserArchiveRecoveryPort(expected: ExpectedReader): Promise<ArchiveRecoveryPort> {
  const { archiveRecoverySender, archiveRecoveryCall } = await import('./server');
  const headers = { 'X-CSRF-Token': expected.expectedCredential };
  const sender = await archiveRecoverySender({ data: expected, headers });
  async function call<K extends keyof ArchiveRecoveryPort>(operation: K, args: Parameters<ArchiveRecoveryPort[K]>) {
    const reply = await archiveRecoveryCall({
      data: { ...expected, sender, operation, args } as Parameters<typeof archiveRecoveryCall>[0]['data'],
      headers,
    });
    return reply as Awaited<ReturnType<ArchiveRecoveryPort[K]>>;
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
    label: (id) => call('label', [id]),
  };
}
