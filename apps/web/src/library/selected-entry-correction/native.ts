import type {
  KernelClient,
  EntryAnnotationCorrectionSelection,
  EntryAnnotationCorrectionPage,
  EntryAnnotationCorrectionCancelResult,
} from '@rezics/client';
import { readPrivateEntry, type PrivateEntryRead } from '../rich-private-entry/native';

export type CorrectionCommand =
  | { kind: 'create'; items: EntryAnnotationCorrectionSelection[]; key: string }
  | { kind: 'confirm'; reviewId: string; body: { epoch: string; position: number }; key: string }
  | { kind: 'cancel'; reviewId: string; body: { epoch: string }; key: string };
export type NativeResult<T> =
  | { kind: 'ready'; value: T }
  | { kind: 'uncertain' }
  | { kind: 'rejected'; status: number };
export type CommandResult = NativeResult<EntryAnnotationCorrectionPage | EntryAnnotationCorrectionCancelResult>;

/** Keys remain logical until this single HTTP boundary. The native review owns item request IDs. */
export async function sendCorrection(
  client: KernelClient,
  authorization: string,
  command: CorrectionCommand,
): Promise<CommandResult> {
  const options = { headers: { authorization, 'idempotency-key': JSON.stringify(command.key) } };
  try {
    if (command.kind === 'create') {
      const result = await client.libraryEntryAnnotationCorrections.post({ items: command.items }, options);
      return result.error ? failure(result.status) : { kind: 'ready', value: result.data.review };
    }
    const route = client.libraryEntryAnnotationCorrections({ reviewId: command.reviewId });
    if (command.kind === 'confirm') {
      const result = await route.confirm.post(command.body, options);
      return result.error ? failure(result.status) : { kind: 'ready', value: result.data.review };
    }
    const result = await route.cancel.post(command.body, options);
    return result.error ? failure(result.status) : { kind: 'ready', value: result.data };
  } catch (error) {
    // A fetch transport failure can follow a committed native edit. Retain its command for original replay.
    if (error instanceof TypeError) return { kind: 'uncertain' };
    throw error;
  }
}
function failure(status: number): { kind: 'uncertain' } | { kind: 'rejected'; status: number } {
  return status >= 500 ? { kind: 'uncertain' } : { kind: 'rejected', status };
}
export async function readCorrection(
  client: KernelClient,
  authorization: string,
  reviewId: string,
  page: number,
): Promise<NativeResult<EntryAnnotationCorrectionPage>> {
  const result = await client
    .libraryEntryAnnotationCorrections({ reviewId })
    .get({ query: { page }, headers: { authorization } });
  return result.error ? failure(result.status) : { kind: 'ready', value: result.data.review };
}
export type CorrectionPort = {
  send: (command: CorrectionCommand) => Promise<CommandResult>;
  read: (reviewId: string, page: number) => Promise<NativeResult<EntryAnnotationCorrectionPage>>;
  personal: (subjectId: string) => Promise<PrivateEntryRead>;
};
export const correctionNative = (client: KernelClient, authorization: string): CorrectionPort => ({
  send: (command) => sendCorrection(client, authorization, command),
  read: (reviewId, page) => readCorrection(client, authorization, reviewId, page),
  personal: (subjectId) => readPrivateEntry(client, subjectId, authorization),
});
