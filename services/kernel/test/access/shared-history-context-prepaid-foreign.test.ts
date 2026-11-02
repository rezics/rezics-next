import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
  consumeSelectedHistoryOriginal,
  identityOriginalRemainder,
  withIdentityOriginalSourceTransfer,
  withSelectedHistoryOriginal,
  type HistoryOriginalDependencies,
  type IdentityOriginalSourceContext,
} from '../../src/access/identity-original-admission.ts';
import { admitSharedHistory } from '../../src/access/shared-history.ts';
import { noEffect, runCommand } from '../../src/command/command.ts';
import { identityHistoryCommand } from '../../src/history/agent-identity-inventory-work.ts';
import {
  assertAgentIdentityHistoryUnit,
  withPrepaidAgentIdentityHistoryUnit,
  type IdentitySourceConsumerMaintenanceContext,
} from '../../src/history/agent-identity-retirement.ts';
import { HistoryRegistry } from '../../src/history/registry.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { createWorkClient } from '../../src/work/client.ts';
import { observeSql } from '../content/support/sql-observer.ts';
import { createDeletionFixture } from '../semantic/support/deletion-fixture.ts';

// Authored native regressions, UNRUN. Every context comes from the real installed
// producers. Missing whole-child partitions or the Source receiver remain failures;
// this fixture never manufactures a grant, receiving adapter or erasure receipt.
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
    deps: HistoryOriginalDependencies & { env: Record<string, string | undefined>; clock: () => Date },
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

for (const entry of ['assertion', 'command'] as const) {
  test(`A previous genuine callback context poisons the current unit through ${entry}, before native checkout`, async () => {
    let previous: IdentitySourceConsumerMaintenanceContext | undefined;
    await authentic((deps, parent) =>
      withPrepaidAgentIdentityHistoryUnit(deps, parent, async (funded) => {
        previous = funded;
      }),
    );
    expect(previous).toBeDefined();
    await authentic(async (deps, parent) => {
      await expect(
        withPrepaidAgentIdentityHistoryUnit(deps, parent, async (funded) => {
          expect(funded).not.toBe(previous);
          const observer = observeSql(deps.pool);
          try {
            let entered = false;
            if (entry === 'assertion')
              expect(() => assertAgentIdentityHistoryUnit(deps.pool, previous!, deps.client)).toThrow('callback-ended');
            else
              await expect(
                identityHistoryCommand(deps.pool, previous!, async () => {
                  entered = true;
                }),
              ).rejects.toThrow('callback-ended');
            // Switching back to the exact current context cannot clear the poison.
            expect(() => assertAgentIdentityHistoryUnit(deps.pool, funded, deps.client)).toThrow('callback-ended');
            await expect(
              identityHistoryCommand(deps.pool, funded, async () => {
                entered = true;
              }),
            ).rejects.toThrow('callback-ended');
            expect(entered).toBe(false);
            expect(observer.records).toHaveLength(0);
          } finally {
            await observer.close();
          }
        }),
      ).rejects.toThrow('callback-ended');
    });
  });
}
