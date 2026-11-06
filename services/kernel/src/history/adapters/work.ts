import type { Pool } from 'pg';
import {
  prepareNativeRecordPurgeAuthority,
  recordHistoryPurgeRestartReference,
  type RecordHistoryPurgeLocator,
} from './record-resource-adapter.ts';
import { minimizeRecordHistoryPurge, prepareRecordHistoryPurge } from './record-purge.ts';
import { registerHistoryFamilyCoverage } from './family-coverage-work.ts';
import type { WorkModule } from '../../work/registry.ts';
import type { WorkClient } from '../../work/client.ts';
import { withSelectedHistoryOriginal } from '../../access/identity-original-admission.ts';
import {
  advanceSharedHistory,
  localSharedHistoryWorkModule as localHistoryWorkModule,
} from '../application/index.ts';
import { HistoryRegistry, type SharedHistoryResult } from '../contract/index.ts';

/** Preserve the delivered local minimizers and add the independent selected-family aggregate. */
export const sharedHistoryWorkModule: WorkModule = {
  name: 'shared_history',
  async register(context) {
    await localHistoryWorkModule.register(context);
    registerHistoryFamilyCoverage(context);
  },
};
export { sharedHistoryWorkModule as preferenceHistoryWorkModule };

/** The default worker's actual selected caller, independently of Source callback allocation. */
export function advanceSelectedHistoryOriginal(
  deps: Readonly<{
    pool: Pool;
    client: WorkClient;
    registry: HistoryRegistry;
    env: Readonly<Record<string, string | undefined>>;
    clock: () => Date;
  }>,
): Promise<SharedHistoryResult | null> {
  return withSelectedHistoryOriginal(deps, (jobId) => advanceSharedHistory(deps, jobId));
}

/** Redrive one existing native record job from its durable source locator. A restart always
 * reissues the real native authority; saved source observations never authorize payload changes. */
export async function advanceOutstandingRecordHistory(pool: Pool, clock: () => Date): Promise<void> {
  const selected = await pool.query<RecordHistoryPurgeLocator>(
    `UPDATE core.record_history_purge SET next_run=now()+interval '30 seconds'
     WHERE (source_key,deletion_generation)=(SELECT source_key,deletion_generation FROM core.record_history_purge
       WHERE next_run<=now() ORDER BY next_run,source_key,deletion_generation LIMIT 1 FOR UPDATE SKIP LOCKED)
     RETURNING source_key,partition_no,reference_kind,resource_id,
       subject_id,candidate_id,revision,document_id,deletion_generation`,
  );
  const job = selected.rows[0];
  if (!job) return;
  const deps = { pool, clock },
    context = { deadline: Date.now() + 5000 };
  const authority = await prepareNativeRecordPurgeAuthority(deps, recordHistoryPurgeRestartReference(job), context);
  if (!authority) return;
  const prepared = await prepareRecordHistoryPurge(deps, authority, context);
  if (prepared) await minimizeRecordHistoryPurge(deps, prepared, context);
}
