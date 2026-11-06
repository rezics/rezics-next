import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { createDeletionFixture } from '../semantic/support/deletion-fixture.ts';
import { createWorkClient, type WorkClient } from '../../src/work/client.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { noEffect, runCommand } from '../../src/command/command.ts';
import { admitSharedHistory } from '../../src/access/shared-history.ts';
import { HistoryRegistry } from '../../src/history/contract/registry.ts';
import {
  consumeSelectedHistoryOriginal,
  currentIdentityOriginalTransfer,
  recordSelectedHistoryOriginalProgress,
  reserveIdentityOriginalSourceWork,
  identityOriginalLibraryWork,
  identityOriginalRemainder,
  originalWorkVector,
  withIdentityOriginalSourceTransfer,
  withSelectedHistoryOriginal,
  type IdentityOriginalSourceContext,
} from '../../src/access/identity-original-admission.ts';
import {
  assertAgentIdentityHistoryUnit,
  currentAgentIdentityHistoryUnit,
  withPrepaidAgentIdentityHistoryUnit,
  type IdentitySourceConsumerMaintenanceContext,
} from '../../src/history/adapters/agent-identity-retirement.ts';
import {
  IDENTITY_HISTORY_ACCOUNTS_LOCAL_WORK,
  identityHistoryCommand,
  identityHistoryConnection,
  addNativeWork,
  reserveIdentityHistoryWork,
} from '../../src/history/adapters/agent-identity-inventory-work.ts';
import { identitySourceConsumerLibraryWork } from '../../src/semantic/identity-source-consumer-maintenance.ts';

// These are native integration oracles, deliberately UNRUN in the source-only delivery.
// They do not install missing owner declarations, a receiving adapter or fake SDK receipts.
const f = await createDeletionFixture();
let client: Awaited<ReturnType<typeof createWorkClient>>;
beforeAll(async () => {
  await f.setup();
  client = await createWorkClient(process.env.DATABASE_URL!, f.pool);
});
afterAll(async () => {
  await client?.close();
  await f.close();
});

async function selected<T>(
  body: (
    deps: {
      pool: Pool;
      client: WorkClient;
      registry: HistoryRegistry;
      env: Record<string, string | undefined>;
      clock: () => Date;
    },
    parent: IdentityOriginalSourceContext,
  ) => Promise<T>,
) {
  const account = newId(0);
  const job = randomUUID();
  const registry = new HistoryRegistry();
  await f.admin.query('INSERT INTO access.erasure(route,account_id,version,at) VALUES($1,$2,1,now())', [
    routeOf(account),
    account,
  ]);
  const generation = (
    await f.admin.query(
      `INSERT INTO core.history_registry(singleton,digest,gaps) VALUES(true,$1,'[]')
     ON CONFLICT(singleton) DO UPDATE SET digest=EXCLUDED.digest,generation=core.history_registry.generation+1
     RETURNING generation::text`,
      [registry.digest()],
    )
  ).rows[0]!.generation;
  await runCommand(f.pool, { partition: 0 }, async (tx) => noEffect(await admitSharedHistory(tx, account, job)));
  await f.admin.query(
    `UPDATE core.preference_history_job SET registry_digest=$2,registry_generation=$3,next_run='-infinity' WHERE job_id=$1`,
    [job, registry.digest(), generation],
  );
  const deps = { pool: f.pool, client, registry, env: {}, clock: () => new Date() };
  try {
    return await withSelectedHistoryOriginal(deps, async (jobId, original) => {
      expect(jobId).toBe(job);
      await consumeSelectedHistoryOriginal(deps, original, jobId);
      const remainder = identityOriginalRemainder(deps, original, jobId);
      // A missing original child partition is an actual prerequisite failure, never replaced in this fixture.
      expect(remainder.source).not.toBeNull();
      expect(remainder.library).not.toBeNull();
      return withIdentityOriginalSourceTransfer(deps, original, jobId, (parent) => body(deps, parent));
    });
  } finally {
    await f.admin.query("UPDATE core.preference_history_job SET next_run='infinity' WHERE job_id=$1", [job]);
  }
}

test('Authentic selected-History prepaid callback keeps one private original and cumulative Library ledger through native continuation', async () => {
  let escaped: IdentitySourceConsumerMaintenanceContext | undefined;
  let saved: (() => void) | undefined;
  await selected(async (deps, parent) => {
    const immutableNative = originalWorkVector(parent.native);
    const ledger = identityOriginalLibraryWork(deps, parent.original, parent.jobId);
    await withPrepaidAgentIdentityHistoryUnit(deps, parent, async (funded) => {
      escaped = funded;
      saved = () => assertAgentIdentityHistoryUnit(deps.pool, funded, deps.client);
      expect(funded.deadline).toBe(parent.deadline);
      expect(currentAgentIdentityHistoryUnit()!.prepaid!.parent).toBe(parent);
      expect(identitySourceConsumerLibraryWork(deps.pool, funded.identityConsumerWork, funded.deadline)).toBe(ledger);
      await reserveIdentityHistoryWork(
        deps.pool,
        addNativeWork(
          IDENTITY_HISTORY_ACCOUNTS_LOCAL_WORK.snapshot,
          IDENTITY_HISTORY_ACCOUNTS_LOCAL_WORK.selectedJob,
          IDENTITY_HISTORY_ACCOUNTS_LOCAL_WORK.selectedProgress,
        ),
        funded,
      );
      await identityHistoryConnection(deps.pool, funded, async (tx) => {
        await tx.query('BEGIN');
        try {
          await tx.query("SELECT set_config('statement_timeout',$1,true)", [
            `${Math.max(1, funded.deadline - Date.now())}ms`,
          ]);
          const row = (
            await tx.query('SELECT job_id FROM core.preference_history_job WHERE job_id=$1 FOR UPDATE', [parent.jobId])
          ).rows[0];
          expect(row.job_id).toBe(parent.jobId);
          expect(currentAgentIdentityHistoryUnit()!.context).toBe(funded);
          // This fixture has no artifact to erase. Exercise actual operational
          // cursor recording without manufacturing command resources or a receipt.
          await tx.query('UPDATE core.preference_history_job SET scan_partition=scan_partition+1 WHERE job_id=$1', [
            parent.jobId,
          ]);
          const root = currentIdentityOriginalTransfer(deps, parent.jobId);
          expect(root).not.toBeNull();
          await recordSelectedHistoryOriginalProgress(deps, root!, parent.jobId, tx);
          await tx.query('COMMIT');
        } catch (error) {
          await tx.query('ROLLBACK');
          throw error;
        }
      });
      expect(identityOriginalLibraryWork(deps, parent.original, parent.jobId)).toBe(ledger);
      expect(originalWorkVector(parent.native)).toEqual(immutableNative);
    });
    expect(saved).toBeDefined();
    expect(() => saved!()).toThrow('callback-ended');
    await expect(
      reserveIdentityHistoryWork(deps.pool, IDENTITY_HISTORY_ACCOUNTS_LOCAL_WORK.selectedJob, escaped!),
    ).rejects.toThrow('callback-ended');
    await expect(withPrepaidAgentIdentityHistoryUnit(deps, parent, async () => {})).rejects.toThrow('already-entered');
  });
});

for (const wrong of ['pool', 'client', 'registry', 'job', 'copy', 'expiry'] as const) {
  test(`Actual prepaid parent refuses ${wrong} authority before consumer dispatch`, async () => {
    await selected(async (deps, parent) => {
      const changed =
        wrong === 'pool'
          ? { ...deps, pool: f.admin }
          : wrong === 'client'
            ? { ...deps, client: { ...deps.client } as WorkClient }
            : wrong === 'registry'
              ? { ...deps, registry: new HistoryRegistry() }
              : deps;
      const received =
        wrong === 'job'
          ? { ...parent, jobId: randomUUID() }
          : wrong === 'copy'
            ? { ...parent, original: { ...parent.original } }
            : parent;
      let dispatched = false;
      const now = Date.now;
      try {
        if (wrong === 'expiry') Date.now = () => parent.deadline;
        await expect(
          withPrepaidAgentIdentityHistoryUnit(changed, received, async () => {
            dispatched = true;
          }),
        ).rejects.toThrow();
      } finally {
        Date.now = now;
      }
      expect(dispatched).toBe(false);
      // Propagate the expired parent's refusal instead of pretending its final transfer can settle.
      if (wrong === 'expiry') throw new Error('expired-native-parent');
    }).catch((error) => {
      if (wrong !== 'expiry' || error.message !== 'expired-native-parent') throw error;
    });
  });
}

for (const poison of ['copy-context', 'nested'] as const) {
  test(`Actual prepaid callback poisons ${poison} even if its immediate refusal is caught`, async () => {
    await selected(async (deps, parent) => {
      await expect(
        withPrepaidAgentIdentityHistoryUnit(deps, parent, async (funded) => {
          if (poison === 'nested')
            await expect(withPrepaidAgentIdentityHistoryUnit(deps, parent, async () => {})).rejects.toThrow(
              'reentered',
            );
          else
            expect(() => assertAgentIdentityHistoryUnit(deps.pool, { ...funded }, deps.client)).toThrow(
              'context-changed',
            );
        }),
      ).rejects.toThrow(poison === 'nested' ? 'reentered' : 'context-changed');
    });
  });
}

test('An ambiguous released COMMIT dispatches its separately prepaid ROLLBACK; callback failure cannot refill or replay', async () => {
  await selected(async (deps, parent) => {
    const failure = new Error('actual COMMIT response lost');
    let escaped: IdentitySourceConsumerMaintenanceContext | undefined;
    let escapedQuery: (() => Promise<unknown>) | undefined;
    const dispatched: string[] = [];
    await expect(
      withPrepaidAgentIdentityHistoryUnit(deps, parent, async (funded) => {
        escaped = funded;
        await reserveIdentityHistoryWork(
          deps.pool,
          addNativeWork(
            IDENTITY_HISTORY_ACCOUNTS_LOCAL_WORK.snapshot,
            IDENTITY_HISTORY_ACCOUNTS_LOCAL_WORK.selectedJob,
          ),
          funded,
        );
        await identityHistoryConnection(deps.pool, funded, async (tx) => {
          const query = tx.query.bind(tx);
          escapedQuery = () => query('SELECT job_id FROM core.preference_history_job WHERE job_id=$1', [parent.jobId]);
          await query('BEGIN ISOLATION LEVEL REPEATABLE READ');
          await query("SELECT set_config('statement_timeout',$1,true)", [
            `${Math.max(1, funded.deadline - Date.now())}ms`,
          ]);
          try {
            const row = (await query('SELECT job_id FROM core.preference_history_job WHERE job_id=$1', [parent.jobId]))
              .rows[0];
            expect(row.job_id).toBe(parent.jobId);
            dispatched.push('COMMIT');
            await query('COMMIT'); // Real native COMMIT; only its response is faulted.
            throw failure;
          } catch (error) {
            dispatched.push('ROLLBACK');
            await query('ROLLBACK');
            throw error;
          }
        });
      }),
    ).rejects.toBe(failure);
    expect(dispatched).toEqual(['COMMIT', 'ROLLBACK']);
    await expect(escapedQuery!()).rejects.toThrow('transaction-ended');
    await expect(
      reserveIdentityHistoryWork(deps.pool, IDENTITY_HISTORY_ACCOUNTS_LOCAL_WORK.selectedJob, escaped!),
    ).rejects.toThrow('callback-ended');
    await expect(withPrepaidAgentIdentityHistoryUnit(deps, parent, async () => {})).rejects.toThrow('already-entered');
    // Already dispatched Source work is not restored when the consumer fails.
    // The whole original cannot be reserved again; no replacement budget is used.
    expect(() => reserveIdentityOriginalSourceWork(deps, parent.original, parent.jobId, parent.native)).toThrow();
  });
});

test('An authentic callback uses Core prepaid command dispatch and still rejects unclassified native work', async () => {
  await selected(async (deps, parent) => {
    await withPrepaidAgentIdentityHistoryUnit(deps, parent, async (funded) => {
      let ran = false;
      const result = await identityHistoryCommand(deps.pool, funded, async () => {
        ran = true;
        return parent.originalId;
      });
      expect(result).toBe(parent.originalId);
      expect(ran).toBe(true);
      await expect(
        reserveIdentityHistoryWork(
          deps.pool,
          { rows: 1, points: 1, statements: 1, bytes: 64, engineRequests: 0 },
          funded,
        ),
      ).rejects.toThrow('identity-history-native-eight-axis-term-unavailable');
    });
  });
});
