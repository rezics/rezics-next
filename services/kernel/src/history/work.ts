// Compatibility export for existing callers; the default native worker owns all history progress.
export { sharedHistoryWorkModule as preferenceHistoryWorkModule } from '../access/shared-history-work.ts';

import type { Pool } from 'pg';
import { prepareRecordPurgeAuthority } from '../semantic/record-purge-authority.ts';
import { minimizeRecordHistoryPurge, prepareRecordHistoryPurge } from './record-purge.ts';

/** Redrive one existing native record job from its durable source locator. A restart always
 * reissues the real native authority; saved source observations never authorize payload changes. */
export async function advanceOutstandingRecordHistory(pool: Pool, clock: () => Date): Promise<void> {
  const selected = await pool.query<{
    subject_id: string;
    candidate_id: string;
    revision: number;
    document_id: string | null;
    deletion_generation: string;
  }>(
    `UPDATE core.record_history_purge SET next_run=now()+interval '30 seconds'
     WHERE (source_key,deletion_generation)=(SELECT source_key,deletion_generation FROM core.record_history_purge
       WHERE next_run<=now() ORDER BY next_run,source_key,deletion_generation LIMIT 1 FOR UPDATE SKIP LOCKED)
     RETURNING subject_id,candidate_id,revision,document_id,deletion_generation`,
  );
  const job = selected.rows[0];
  if (!job) return;
  const deps = { pool, clock },
    context = { deadline: Date.now() + 5000 };
  const authority = await prepareRecordPurgeAuthority(
    deps,
    {
      subjectId: job.subject_id,
      candidateId: job.candidate_id,
      revision: job.revision,
      documentId: job.document_id,
      deletionGeneration: job.deletion_generation,
    },
    context,
  );
  if (!authority) return;
  const prepared = await prepareRecordHistoryPurge(deps, authority, context);
  if (prepared) await minimizeRecordHistoryPurge(deps, prepared, context);
}
