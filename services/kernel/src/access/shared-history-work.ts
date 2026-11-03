import { advanceOutstandingRecordHistory, advanceSelectedHistoryOriginal } from '../history/work.ts';
import type { WorkModule } from '../work/registry.ts';
import { verifyAgentIdentityRecoveryArtifactReadiness } from '../history/agent-identity-recovery-receiving.ts';
import { admitSharedHistory } from './shared-history.ts';
import { advancePendingContextRoleProvenance, type ContextRoleOccurrence } from './shared-history-context.ts';
import type { HistoryReceivingContext } from '../history/receiving.ts';

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
      name: 'access.agent-identity.recover',
      artifactType: 'command-receipt/v1',
      version: 1,
      async readiness(tx, artifact, barrier, receiving) {
        const recovery = await verifyAgentIdentityRecoveryArtifactReadiness(tx, artifact, barrier, context.pool, {
          ...(receiving?.deadline === undefined ? {} : { deadline: receiving.deadline }),
          ...(receiving?.accountErasureSearchObservation === undefined
            ? {}
            : { searchObservation: receiving.accountErasureSearchObservation }),
          ...(receiving?.recoveryReceivingReserved === undefined
            ? {}
            : { recoveryReceivingReserved: receiving.recoveryReceivingReserved }),
        });
        if (recovery.state === 'ready') return { ready: true };
        return {
          ready: false,
          gap: recovery.state === 'pending' ? recovery.gap : 'agent-identity-recovery-inventory-unavailable',
        };
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
    history.registerOwner({
      name: 'com.rezics.access.account-updated.v1',
      artifactType: 'outbox-event/v1',
      version: 1,
      async readiness(tx, artifact, barrier, receiving: HistoryReceivingContext | undefined) {
        const recovery = await verifyAgentIdentityRecoveryArtifactReadiness(tx, artifact, barrier, context.pool, {
          ...(receiving?.deadline === undefined ? {} : { deadline: receiving.deadline }),
          ...(receiving?.accountErasureSearchObservation === undefined
            ? {}
            : { searchObservation: receiving.accountErasureSearchObservation }),
          ...(receiving?.recoveryReceivingReserved === undefined
            ? {}
            : { recoveryReceivingReserved: receiving.recoveryReceivingReserved }),
        });
        if (recovery.state === 'ready') return { ready: true };
        if (recovery.state === 'pending') return { ready: false, gap: recovery.gap };
        return { ready: false, gap: 'account-updated-owner-currentness-unavailable' };
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
      let contextHome = -1;
      // Only native source keys, bounded by the fixed partition map. Losing this scheduling
      // cursor on restart rereads pending rows; it never acknowledges or drops an occurrence.
      const contextCursors = new Map<number, ContextRoleOccurrence>();
      const tick = () => {
        running = (async () => {
          try {
            // Keyset one configured home per existing unit, releasing discovery before entering
            // its LIVE selection and released native command. No request-time all-home scan
            // or account-bearing work payload.
            const home = (
              await context.pool.query<{ partition_no: number }>(
                'SELECT partition_no FROM core.partition WHERE partition_no>$1 ORDER BY partition_no LIMIT 1',
                [contextHome],
              )
            ).rows[0];
            contextHome = home?.partition_no ?? -1;
            if (home) {
              const after = contextCursors.get(home.partition_no);
              const progress = await advancePendingContextRoleProvenance(
                { pool: context.pool, client: context.client, clock: context.clock },
                { partition: home.partition_no, ...(after === undefined ? {} : { after }) },
              );
              if (progress.after) contextCursors.set(home.partition_no, progress.after);
              else contextCursors.delete(home.partition_no);
            }
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
            await advanceSelectedHistoryOriginal({
              pool: context.pool,
              client: context.client,
              registry: history,
              env: context.env,
              clock: context.clock,
            });
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
