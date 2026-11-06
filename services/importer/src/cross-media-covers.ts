import { createHash } from 'node:crypto';
import type { MediaImportRequest } from '@rezics/definitions/media-import';

/** The owner whose selected cover journal is keyed by its exact source tuple. */
export type SelectedCoverOwner = { source: string; external_id: string };

/** The durable media journal a selected cover resumes from; only acceptance and the final status matter. */
export type SelectedCoverJournal = { accepted: unknown; status: { media: { state: string } } | null };

/** The two capabilities a resume needs: exact-key journal lookup and the coordinator's media resolver. */
export type SelectedCoverResumePort = {
  bindings: { mediaPending(owner: SelectedCoverOwner, key: string): SelectedCoverJournal | null };
  resolver: {
    resolve(input: {
      owner: SelectedCoverOwner;
      subject: string;
      mediaImportIntents: MediaImportRequest[];
      signal: AbortSignal;
      deferPending: boolean;
    }): Promise<unknown>;
  };
};

/**
 * Resume a selected cover whose sealed media journal is not final. A prepared request replays its exact bytes and
 * key, and an accepted reservation polls its own Media ID. A final journal, or none, makes no media call.
 */
export async function resumeSelectedCover(
  port: SelectedCoverResumePort,
  input: { owner: SelectedCoverOwner; containerId: string; intent: MediaImportRequest; signal: AbortSignal },
): Promise<'absent' | 'final' | 'resumed'> {
  const signature = createHash('sha256').update(JSON.stringify(input.intent)).digest('hex');
  const key = `${input.owner.source}:${input.owner.external_id}:${signature}`;
  const journal = port.bindings.mediaPending(input.owner, key);
  if (!journal) return 'absent';
  const state = journal.status?.media.state;
  if (journal.accepted !== null && (state === 'available' || state === 'rejected')) return 'final';
  await port.resolver.resolve({
    owner: input.owner,
    subject: input.containerId,
    mediaImportIntents: [input.intent],
    signal: input.signal,
    deferPending: false,
  });
  return 'resumed';
}
