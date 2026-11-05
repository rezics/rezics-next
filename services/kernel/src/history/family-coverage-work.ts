import type { WorkContext } from '../work/registry.ts';
import { withConnection } from '../database/pool.ts';
import type { HistoryProducerFamily } from './registry.ts';
import { advanceHistoryFamilyCoverage, installHistoryFamilyDefinitions } from './family-coverage.ts';

/** Same default native runtime as local minimization. No foreign owner work or connection is
 * held across units, and no account/role payload enters a generic durable execution. */
export function registerHistoryFamilyCoverage(context: WorkContext): void {
  const registry = context.history;
  if (!registry) throw new Error('History family coverage requires native work composition');
  context.addService(async () => {
    await withConnection(context.pool, (tx) => installHistoryFamilyDefinitions(tx, registry));
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let running: Promise<void> = Promise.resolve();
    const tick = () => {
      running = (async () => {
        try {
          // Only the existing native history job inventory is admitted. Keyset bootstrap is
          // finite; the insertion trigger covers jobs arriving behind its cursor.
          await withConnection(context.pool, async (tx) => {
            await tx.query('BEGIN');
            try {
              await tx.query("SET LOCAL statement_timeout='2s'");
              const definition = (
                await tx.query<{ family: HistoryProducerFamily; admit_cursor: string | null }>(
                  `SELECT family,admit_cursor FROM core.history_family_definition WHERE NOT admission_complete
                 ORDER BY family LIMIT 1 FOR UPDATE SKIP LOCKED`,
                )
              ).rows[0];
              if (definition) {
                const jobs = (
                  await tx.query<{ job_id: string; account_route: number; account_id: string }>(
                    `SELECT job_id,account_route,account_id FROM core.preference_history_job
                   WHERE job_id>COALESCE($1::uuid,'00000000-0000-0000-0000-000000000000'::uuid)
                   ORDER BY job_id LIMIT 100`,
                    [definition.admit_cursor],
                  )
                ).rows;
                for (const job of jobs)
                  await tx.query('SELECT core.history_family_admit($1,$2,$3)', [
                    definition.family,
                    job.account_route,
                    job.account_id,
                  ]);
                await tx.query(
                  'UPDATE core.history_family_definition SET admit_cursor=$2,admission_complete=$3 WHERE family=$1',
                  [definition.family, jobs.at(-1)?.job_id ?? definition.admit_cursor, jobs.length < 100],
                );
              }
              await tx.query('COMMIT');
            } catch (error) {
              await tx.query('ROLLBACK');
              throw error;
            }
          });
          // Routing/config changes reopen one old aggregate per unit through the generation index.
          await context.pool.query(
            `UPDATE core.history_family_coverage SET phase='scan',gap=NULL,proof_id=NULL,next_run=now()
             WHERE (family,account_route,account_id)=(
               SELECT family,account_route,account_id FROM core.history_family_coverage
               WHERE domain_generation<(SELECT generation FROM core.history_family_domain WHERE singleton)
                 AND phase<>'scan' ORDER BY domain_generation,family,account_route,account_id LIMIT 1
               FOR UPDATE SKIP LOCKED)`,
          );
          const selected = (
            await context.pool.query<{
              family: HistoryProducerFamily;
              account_route: number;
              account_id: string;
              barrier_version: number;
              barrier_at: string;
            }>(
              `UPDATE core.history_family_coverage SET next_run=now()+interval '10 seconds'
             WHERE (family,account_route,account_id)=(SELECT family,account_route,account_id
               FROM core.history_family_coverage WHERE phase='scan' AND next_run<=now()
               ORDER BY next_run,family,account_route,account_id LIMIT 1 FOR UPDATE SKIP LOCKED)
             RETURNING family,account_route,account_id,barrier_version,barrier_at`,
            )
          ).rows[0];
          if (selected)
            await advanceHistoryFamilyCoverage(
              { pool: context.pool },
              {
                accountRoute: selected.account_route,
                accountId: selected.account_id,
                version: selected.barrier_version,
                at: selected.barrier_at,
              },
              selected.family,
            );
        } catch {
          console.error('history_family_retry');
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
}
