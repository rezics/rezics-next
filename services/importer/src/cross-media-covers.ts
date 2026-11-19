import type { ImporterOptions } from './importer.ts';
import { mediaJournalRequest } from './media-resolver.ts';
import type { Owner, RecordBindings } from './record-bindings.ts';
import type { MediaImportRequest } from '@rezics/definitions/media-import';

type SelectedCoverReceipt = {
  status: 'available' | 'rejected';
  mediaState: 'available' | 'rejected';
  mediaKey: string;
  mediaId?: string;
  credit: MediaImportRequest['credit'];
  provenance: MediaImportRequest['provenance'];
};

/** Read a terminal observation from the exact intent, or resume its unfinished delivery. */
export async function resumeSelectedCover(
  port: { bindings: Pick<RecordBindings, 'mediaPending'>; resolver?: ImporterOptions['mediaResolver'] },
  input: { owner: Owner; containerId: string; intent: MediaImportRequest; signal: AbortSignal },
): Promise<SelectedCoverReceipt | undefined> {
  const { key, signature, request } = mediaJournalRequest(input.owner, input.intent);
  const journal = port.bindings.mediaPending(input.owner, key);
  if (!journal) return;
  if (journal.signature !== signature || journal.bytes !== JSON.stringify(request))
    throw new TypeError('Selected cover does not match its sealed request');
  const media = journal.status?.media;
  if (journal.accepted && media && (media.state === 'available' || media.state === 'rejected'))
    return {
      status: media.state,
      mediaState: media.state,
      mediaKey: key,
      ...(media.state === 'available' ? { mediaId: media.id } : {}),
      // The journal verified both fields on observation. Keep the converter's original manifest representation.
      credit: input.intent.credit,
      provenance: input.intent.provenance,
    };
  await port.resolver?.resolve({
    owner: input.owner,
    subject: input.containerId,
    mediaImportIntents: [input.intent],
    signal: input.signal,
    deferPending: false,
  });
}
