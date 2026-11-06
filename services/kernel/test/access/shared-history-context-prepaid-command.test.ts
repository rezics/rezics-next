import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
  currentCommand,
  currentCommandResources,
  noEffect,
  registerCommandCallback,
  runCommand,
  type CommandTransaction,
} from '../../src/command/command.ts';
import { COMMAND_DISPATCH_ALLOWANCE } from '../../src/command/dispatch-lifetime.ts';
import {
  consumeSelectedHistoryOriginal,
  currentIdentityOriginalTransfer,
  identityOriginalLibraryWork,
  identityOriginalRemainder,
  ORIGINAL_AXES,
  recordSelectedHistoryOriginalProgress,
  reserveIdentityOriginalSourceWork,
  withIdentityOriginalSourceTransfer,
  withSelectedHistoryOriginal,
  type IdentityOriginalSourceContext,
} from '../../src/access/identity-original-admission.ts';
import { admitSharedHistory } from '../../src/access/shared-history.ts';
import {
  assertAgentIdentityHistoryUnit,
  currentAgentIdentityHistoryUnit,
  withAgentIdentityHistoryUnit,
  withPrepaidAgentIdentityHistoryUnit,
  type IdentitySourceConsumerMaintenanceContext,
} from '../../src/history/agent-identity-retirement.ts';
import {
  addNativeWork,
  IDENTITY_HISTORY_ACCOUNTS_DECLARATION,
  IDENTITY_HISTORY_ACCOUNTS_LOCAL_WORK,
  identityHistoryCommand,
  reserveIdentityHistoryWork,
} from '../../src/history/agent-identity-inventory-work.ts';
import { HistoryRegistry } from '../../src/history/registry.ts';
import type { WorkDimensions } from '../../src/library/contract/work-dimensions.ts';
import { identitySourceConsumerNativeWork } from '../../src/semantic/identity-source-consumer-maintenance.ts';
import { createWorkClient } from '../../src/work/client.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { observeSql } from '../content/support/sql-observer.ts';
import { createDeletionFixture } from '../semantic/support/deletion-fixture.ts';

// Authored native outcomes, UNRUN. Nothing here installs a missing declaration,
// Source receiver, synthetic original, transaction or positive erasure receipt.
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

async function authentic<T>(
  body: (
    deps: {
      pool: typeof f.pool;
      client: typeof client;
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
    `UPDATE core.preference_history_job SET registry_digest=$2,registry_generation=$3,next_run='-infinity'
     WHERE job_id=$1`,
    [job, registry.digest(), generation],
  );
  const deps = { pool: f.pool, client, registry, env: {}, clock: () => new Date() };
  try {
    return await withSelectedHistoryOriginal(deps, async (jobId, original) => {
      expect(jobId).toBe(job);
      await consumeSelectedHistoryOriginal(deps, original, jobId);
      const remainder = identityOriginalRemainder(deps, original, jobId);
      if (remainder.source === null || remainder.library === null)
        throw new Error(
          'identity-history-original-source-transfer-unavailable: actual complete child partitions required',
        );
      return withIdentityOriginalSourceTransfer(deps, original, jobId, (parent) => body(deps, parent));
    });
  } finally {
    await f.admin.query("UPDATE core.preference_history_job SET next_run='infinity' WHERE job_id=$1", [job]);
  }
}

// Leave precisely the executable Core quote in the authentic Source ledger. This
// does not fund anything: it spends the rest of an already installed partition.
function rest(parent: IdentityOriginalSourceContext, keep: WorkDimensions): WorkDimensions {
  const work = { ...parent.native };
  for (const axis of ORIGINAL_AXES) {
    work[axis] -= keep[axis];
    expect(work[axis]).toBeGreaterThanOrEqual(0);
  }
  return work;
}
const oneStatement = { ...COMMAND_DISPATCH_ALLOWANCE.cleanup.work };

test('Selected History publishes the actual executable effect plus disjoint cleanup quote', () => {
  const declaration = IDENTITY_HISTORY_ACCOUNTS_DECLARATION();
  expect(declaration.selectedCommand).toBe(COMMAND_DISPATCH_ALLOWANCE);
  expect(declaration.selectedCommand.total.work).toEqual({
    candidateKeys: 0,
    nativeRows: 2,
    identityMetadataRows: 0,
    nativePoints: 1,
    witnessKeys: 0,
    statements: 8,
    bytes: 169,
    emptySeeks: 1,
  });
  expect(declaration.selectedCommandCalls).toEqual({
    retirement: 8,
    physicalMinimization: 3,
    physicalFenceReceiving: 4,
    selectedContinuation: 1,
  });
  expect(declaration.missingTerms.some((term) => term.startsWith('NativeCommandDispatchLifetime:'))).toBe(false);
  expect(declaration.missingTerms.some((term) => term.startsWith('LibraryAllReachedCalls:'))).toBe(true);
  expect('work' in declaration).toBe(false);
});

test('One authentic command spends exactly Core total once, preserves the old Source counter and never refunds unused cleanup', async () => {
  await authentic(async (deps, parent) => {
    await withPrepaidAgentIdentityHistoryUnit(deps, parent, async (funded) => {
      const unit = currentAgentIdentityHistoryUnit();
      const ledger = identityOriginalLibraryWork(deps, parent.original, parent.jobId);
      const oldBalance = identitySourceConsumerNativeWork(deps.pool, funded.identityConsumerWork, funded.deadline);
      reserveIdentityOriginalSourceWork(
        deps,
        parent.original,
        parent.jobId,
        rest(parent, COMMAND_DISPATCH_ALLOWANCE.total.work),
      );
      const observer = observeSql(deps.pool);
      try {
        const value = await identityHistoryCommand(deps.pool, funded, async (tx) => {
          expect(currentCommandResources(tx).pool).toBe(deps.pool);
          expect(currentCommandResources(tx).deadline).toBe(parent.deadline);
          expect(currentCommand(tx).partition).toBe(0);
          expect(currentAgentIdentityHistoryUnit()).toBe(unit);
          return parent.originalId;
        });
        expect(value).toBe(parent.originalId);
        expect(observer.records).toHaveLength(7); // seven real effect statements, no body SQL
        expect(observer.records.at(-1)!.statement).toBe('COMMIT');
        expect(new Set(observer.records.map((row) => row.connectionId)).size).toBe(1);
        expect(identitySourceConsumerNativeWork(deps.pool, funded.identityConsumerWork, funded.deadline)).toEqual(
          oldBalance,
        );
        expect(identityOriginalLibraryWork(deps, parent.original, parent.jobId)).toBe(ledger);
        expect(() => reserveIdentityOriginalSourceWork(deps, parent.original, parent.jobId, oneStatement)).toThrow();
        const count = observer.records.length;
        await expect(identityHistoryCommand(deps.pool, funded, async () => 'refill')).rejects.toThrow();
        expect(observer.records).toHaveLength(count);
      } finally {
        await observer.close();
      }
    });
  });
});

test('Insufficient cleanup capacity refuses atomically before checkout without partially spending the effect quote', async () => {
  await authentic(async (deps, parent) => {
    await withPrepaidAgentIdentityHistoryUnit(deps, parent, async (funded) => {
      reserveIdentityOriginalSourceWork(
        deps,
        parent.original,
        parent.jobId,
        rest(parent, COMMAND_DISPATCH_ALLOWANCE.effect.work),
      );
      const observer = observeSql(deps.pool);
      try {
        let entered = false;
        await expect(
          identityHistoryCommand(deps.pool, funded, async () => {
            entered = true;
          }),
        ).rejects.toThrow();
        expect(entered).toBe(false);
        expect(observer.records).toHaveLength(0);
        // A partial debit would make this genuine same-ledger reservation fail.
        reserveIdentityOriginalSourceWork(deps, parent.original, parent.jobId, COMMAND_DISPATCH_ALLOWANCE.effect.work);
      } finally {
        await observer.close();
      }
    });
  });
});

test('Final native cursor and original progress commit under the same actual unit and private native transaction', async () => {
  await authentic(async (deps, parent) => {
    let escaped: CommandTransaction | undefined;
    let fundedContext: IdentitySourceConsumerMaintenanceContext | undefined;
    await withPrepaidAgentIdentityHistoryUnit(deps, parent, async (funded) => {
      fundedContext = funded;
      await identityHistoryCommand(deps.pool, funded, async (tx) => {
        escaped = tx;
        await reserveIdentityHistoryWork(
          deps.pool,
          addNativeWork(
            IDENTITY_HISTORY_ACCOUNTS_LOCAL_WORK.selectedJob,
            IDENTITY_HISTORY_ACCOUNTS_LOCAL_WORK.selectedProgress,
          ),
          funded,
        );
        const job = (
          await tx.query('SELECT job_id FROM core.preference_history_job WHERE job_id=$1 FOR UPDATE', [parent.jobId])
        ).rows[0];
        expect(job.job_id).toBe(parent.jobId);
        await tx.query('UPDATE core.preference_history_job SET scan_partition=scan_partition+1 WHERE job_id=$1', [
          parent.jobId,
        ]);
        const root = currentIdentityOriginalTransfer(deps, parent.jobId);
        expect(root).not.toBeNull();
        await recordSelectedHistoryOriginalProgress(deps, root!, parent.jobId, tx);
        assertAgentIdentityHistoryUnit(deps.pool, funded, deps.client);
      });
      await expect(escaped!.query('SELECT 1')).rejects.toThrow();
    });
    await expect(identityHistoryCommand(deps.pool, fundedContext!, async () => 'escaped')).rejects.toThrow(
      'callback-ended',
    );
    await expect(withPrepaidAgentIdentityHistoryUnit(deps, parent, async () => {})).rejects.toThrow('already-entered');
  });
});

for (const rollbackFails of [false, true]) {
  test(`Failed native COMMIT keeps its one same-client prepaid ROLLBACK${rollbackFails ? ' failure evidence' : ''} without refill`, async () => {
    await authentic(async (deps, parent) => {
      await withPrepaidAgentIdentityHistoryUnit(deps, parent, async (funded) => {
        reserveIdentityOriginalSourceWork(
          deps,
          parent.original,
          parent.jobId,
          rest(parent, COMMAND_DISPATCH_ALLOWANCE.total.work),
        );
        const observer = observeSql(deps.pool);
        const commit = new Error('actual native COMMIT response lost');
        const rollback = new Error('actual native ROLLBACK response lost');
        observer.armFault({ match: { statement: 'COMMIT' }, boundary: 'after', error: commit });
        if (rollbackFails) observer.armFault({ match: { statement: 'ROLLBACK' }, boundary: 'after', error: rollback });
        try {
          const failure = await identityHistoryCommand(deps.pool, funded, async () => 'value').catch(
            (error: unknown) => error,
          );
          if (rollbackFails) {
            expect(failure).toBeInstanceOf(AggregateError);
            expect((failure as AggregateError).errors).toEqual([commit, rollback]);
          } else expect(failure).toBe(commit);
          const controls = observer.records.filter((row) => row.statement === 'COMMIT' || row.statement === 'ROLLBACK');
          expect(controls.map((row) => row.statement)).toEqual(['COMMIT', 'ROLLBACK']);
          expect(new Set(controls.map((row) => row.connectionId)).size).toBe(1);
          expect(() => reserveIdentityOriginalSourceWork(deps, parent.original, parent.jobId, oneStatement)).toThrow();
          const count = observer.records.length;
          await expect(identityHistoryCommand(deps.pool, funded, async () => 'replay')).rejects.toThrow();
          expect(observer.records).toHaveLength(count);
        } finally {
          await observer.close();
        }
      });
    });
  });
}

test('Expiry after the body still dispatches held cleanup without consulting an expired grant again', async () => {
  await authentic(async (deps, parent) => {
    await expect(
      withPrepaidAgentIdentityHistoryUnit(deps, parent, async (funded) => {
        const observer = observeSql(deps.pool);
        const now = Date.now;
        try {
          await expect(
            identityHistoryCommand(deps.pool, funded, async () => {
              Date.now = () => parent.deadline;
            }),
          ).rejects.toThrow();
          expect(observer.records.filter((row) => row.statement === 'ROLLBACK')).toHaveLength(1);
          expect(observer.records.some((row) => row.statement === 'COMMIT')).toBe(false);
          Date.now = now;
          await expect(identityHistoryCommand(deps.pool, funded, async () => 'revived')).rejects.toThrow();
        } finally {
          Date.now = now;
          await observer.close();
        }
      }),
    ).rejects.toThrow();
  });
});

test('A changed registry poisons the genuine unit before checkout even when the caller restores it', async () => {
  await authentic(async (deps, parent) => {
    await expect(
      withPrepaidAgentIdentityHistoryUnit(deps, parent, async (funded) => {
        const registry = deps.registry;
        const observer = observeSql(deps.pool);
        try {
          deps.registry = new HistoryRegistry();
          await expect(identityHistoryCommand(deps.pool, funded, async () => 'foreign')).rejects.toThrow();
          deps.registry = registry;
          await expect(identityHistoryCommand(deps.pool, funded, async () => 'revived')).rejects.toThrow();
          expect(observer.records).toHaveLength(0);
        } finally {
          deps.registry = registry;
          await observer.close();
        }
      }),
    ).rejects.toThrow();
  });
});

test('Unsupported callbacks refuse before final controls; a copied context and nested replacement poison the real callback', async () => {
  await authentic(async (deps, parent) => {
    await withPrepaidAgentIdentityHistoryUnit(deps, parent, async (funded) => {
      const observer = observeSql(deps.pool);
      try {
        await expect(
          identityHistoryCommand(deps.pool, funded, async (tx) => registerCommandCallback(tx, () => {})),
        ).rejects.toThrow();
        expect(observer.records.some((row) => row.statement === 'COMMIT')).toBe(false);
        expect(observer.records.filter((row) => row.statement.startsWith('SET LOCAL statement_timeout'))).toHaveLength(
          1,
        );
        expect(observer.records.filter((row) => row.statement === 'ROLLBACK')).toHaveLength(1);
      } finally {
        await observer.close();
      }
    });
  });
  for (const kind of ['copy', 'reentry'] as const) {
    await authentic(async (deps, parent) => {
      await expect(
        withPrepaidAgentIdentityHistoryUnit(deps, parent, async (funded) => {
          if (kind === 'copy')
            await expect(identityHistoryCommand(deps.pool, { ...funded }, async () => {})).rejects.toThrow(
              'context-changed',
            );
          else
            await expect(
              identityHistoryCommand(deps.pool, funded, async () => {
                await expect(withAgentIdentityHistoryUnit(deps, funded, async () => {})).rejects.toThrow('reentered');
              }),
            ).rejects.toThrow('reentered');
        }),
      ).rejects.toThrow(kind === 'copy' ? 'context-changed' : 'reentered');
    });
  }
});
