import type { KernelClient } from '@rezics/client';

/** Compile-only consumer of the published Eden declarations; never invoked by a fixture. */
export async function entryUndoClientContract(
  client: KernelClient,
  subjectId: string,
  deletionId: string,
  incarnationId: string,
) {
  const entry = client.libraryEntries({ subjectId });
  const result = await entry.$restore.post({ deletionId, revision: 2 }, { headers: { 'idempotency-key': '"undo"' } });
  if (result.data) {
    const restored: { subjectId: string; state: string; revision: number; incarnationId?: string | null } =
      result.data.libraryEntry;
    restored satisfies { subjectId: string; revision: number };
    // @ts-expect-error private storage provenance is absent from public entries
    result.data.libraryEntry.libraryProfilePin;
  }
  await entry.delete({ query: { revision: 1, incarnationId }, headers: { 'idempotency-key': '"clear"' } });
  // @ts-expect-error restore revisions are numbers
  await entry.$restore.post({ deletionId, revision: '2' });
  // @ts-expect-error restore accepts no new state
  await entry.$restore.post({ deletionId, revision: 2, state: 'planned' });
}
