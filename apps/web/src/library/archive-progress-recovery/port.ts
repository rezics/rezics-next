import type { ExpectedReader } from '../../session/expected-reader';
import { archiveTransportLost } from '../archive-entry-recovery/native';
import type { ProgressChoices } from '../progress-profile';
import type { NativePort, ProgressRecoveryPort } from './native';
export type Port = ProgressRecoveryPort<ProgressChoices>;

export async function browserProgressRecoveryPort(expected: ExpectedReader): Promise<Port> {
  const { progressRecoverySender, progressRecoveryCall, progressRecoveryChoices } = await import('./server');
  const headers = { 'X-CSRF-Token': expected.expectedCredential };
  const sender = await progressRecoverySender({ data: expected, headers });
  function call<K extends Exclude<keyof NativePort, 'subject'>>(
    operation: K,
    args: Parameters<NativePort[K]>,
  ): ReturnType<NativePort[K]> {
    const data = { ...expected, ...(sender === undefined ? {} : { sender }), operation, args } as NonNullable<
      Parameters<typeof progressRecoveryCall>[0]
    >['data'];
    return progressRecoveryCall({ data, headers })
      .then((text) => JSON.parse(text) as Awaited<ReturnType<NativePort[K]>>)
      .catch((error) => {
        if (archiveTransportLost(error)) return { kind: 'uncertain' as const };
        throw error;
      }) as ReturnType<NativePort[K]>;
  }
  return {
    upload: (bytes, key) => call('upload', [bytes, key]),
    holdings: (id, after) => call('holdings', [id, after]),
    occurrences: (id, after) => call('occurrences', [id, after]),
    units: (id, session, after) => call('units', [id, session, after]),
    review: (id, body, key) => call('review', [id, body, key]),
    apply: (id, review, key) => call('apply', [id, review, key]),
    result: (id, review) => call('result', [id, review]),
    cancel: (id) => call('cancel', [id]),
    remove: (id) => call('remove', [id]),
    choices: (subjectId) => progressRecoveryChoices({ data: { ...expected, subjectId }, headers }),
  };
}
