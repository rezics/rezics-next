import { advanceOutstandingRecordHistory } from '../history/work.ts';
import type { WorkModule } from '../work/registry.ts';
import { withConnection } from '../database/pool.ts';
import { admitSharedHistory, advanceSharedHistory } from './shared-history.ts';

/** One native receiving worker. Its progress, barrier and errors are never a DBOS argument or
 * generic effect payload. Pending jobs sleep until an actual custody/registration change. */
export const sharedHistoryWorkModule: WorkModule = {
  name: 'shared_history',
  register(context) {
    const history = context.history;
    if (!history || !context.addNativeEffects) throw new Error('Shared history requires native work composition');
    history.registerOwner({
      name: 'library.entry.retention.purge',
      artifactType: 'command-receipt/v1',
      version: 1,
      async readiness() {
        return { ready: true };
      },
    });
    history.registerOwner({
      name: 'access.account.preferences',
      artifactType: 'command-receipt/v1',
      version: 1,
      async readiness() {
        return { ready: true };
      },
    });
    history.registerOwner({
      name: 'com.rezics.library.entry.purged.v1',
      artifactType: 'outbox-event/v1',
      version: 1,
      // The closed deletionId event has no projection subscriber. Exact effects admission and
      // completion are independently enforced by the outbox minimizer.
      async readiness() {
        return { ready: true };
      },
    });
    context.addNativeEffects([
      {
        name: 'shared_history',
        delivery: 'native',
        types: ['com.rezics.access.account-tombstoned.v1'],
        async admit(tx, event) {
          const accountId = (event.data as { accountId: string }).accountId;
          // A random native job identity is not an event/command key or a serialized account scope.
          await admitSharedHistory(tx, accountId, Bun.randomUUIDv7());
        },
      },
    ]);
    context.addService(async () => {
      const digest = history.digest();
      const registration = await context.pool.query<{ generation: string }>(
        `INSERT INTO core.history_registry(singleton,digest,gaps) VALUES(true,$1,$2)
         ON CONFLICT(singleton) DO UPDATE SET digest=EXCLUDED.digest,gaps=EXCLUDED.gaps,
           generation=core.history_registry.generation+CASE WHEN core.history_registry.digest<>EXCLUDED.digest THEN 1 ELSE 0 END
         RETURNING generation`,
        [digest, JSON.stringify(history.gaps())],
      );
      const generation = registration.rows[0]!.generation;
      let stopped = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let running: Promise<void> = Promise.resolve();
      const tick = () => {
        running = (async () => {
          try {
            await advanceOutstandingRecordHistory(context.pool, context.clock);
            // Reopen one dependency-pending job per unit when the actual registry changes.
            await context.pool.query(
              `UPDATE core.preference_history_job SET phase='scan',scan_partition=0,verify_partition=0,
               scan_type=NULL,scan_locator=NULL,gap=NULL,registry_digest=$1,registry_generation=$2,next_run=now()
               WHERE job_id=(SELECT job_id FROM core.preference_history_job
                 WHERE registry_generation<$2 ORDER BY registry_generation,job_id LIMIT 1
                 FOR UPDATE SKIP LOCKED)`,
              [digest, generation],
            );
            const selected = await withConnection(context.pool, async (tx) => {
              // Lease selection commits before any other home or SDK is entered. An expired
              // lease retries the same native cursor; artifact locks make duplicate work safe.
              const rows = await tx.query<{ job_id: string }>(
                `UPDATE core.preference_history_job SET next_run=now()+interval '10 seconds'
                 WHERE job_id=(SELECT job_id FROM core.preference_history_job
                   WHERE phase IN ('scan','verify') AND next_run<=now()
                   ORDER BY next_run,job_id LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING job_id`,
              );
              return rows.rows[0]?.job_id;
            });
            if (selected) {
              const answer = await advanceSharedHistory(
                { pool: context.pool, client: context.client, registry: history },
                selected,
              );
              if (!answer.gap)
                await context.pool.query(
                  `UPDATE core.preference_history_job SET next_run=now() WHERE job_id=$1
                 AND phase IN ('scan','verify') AND next_run>now()`,
                  [selected],
                );
            }
          } catch {
            // Private source/SDK exceptions stay out of diagnostic and durable history.
            console.error('shared_history_retry');
          }
        })().finally(() => {
          if (!stopped) timer = setTimeout(tick, 25);
        });
      };
      tick();
      return {
        async stop() {
          stopped = true;
          if (timer) clearTimeout(timer);
          await running;
        },
      };
    });
  },
};
