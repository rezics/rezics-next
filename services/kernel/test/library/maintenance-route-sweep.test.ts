import { expect, test } from 'bun:test';
import { bindExecutionContract } from '../../src/command/execution-contract.ts';
import { composeLibraryDomain } from '../../src/composition/library.ts';
import { installNativeHistoryPreload } from '../../src/composition/preload.ts';
import { createPool } from '../../src/database/pool.ts';
import { historyExecutionPort } from '../../src/history/application/index.ts';
import { advanceMaintenanceSegment } from '../../src/library/maintenance-route-sweep.ts';
import { libraryWorkModule } from '../../src/library/work-module.ts';
import { newId, PARTITIONS, ROUTES } from '../../src/route/route.ts';
import { createWorkClient } from '../../src/work/client.ts';
import { composeWork } from '../../src/work/registry.ts';
import { workExecutionPort } from '../../src/work/selected-runtime.ts';
import { openIsolatedDatabase } from '../support/isolated-database.ts';
import { workerTestEnv } from '../support/worker-env.ts';

test('empty maintenance sources finish in one durable step and a sparse sweep visits its real route', async () => {
  const database = await openIsolatedDatabase();
  const pool = createPool(database.url);
  installNativeHistoryPreload();
  composeLibraryDomain();
  const client = bindExecutionContract(
    await createWorkClient(database.url, pool),
    workExecutionPort(),
    historyExecutionPort,
  );
  const work = await composeWork([libraryWorkModule], {
    pool,
    client,
    databaseUrl: database.url,
    env: workerTestEnv(),
    executorId: crypto.randomUUID(),
  });
  async function run(workflowName: string) {
    const workflowID = crypto.randomUUID();
    const handle = await client.enqueue({ workflowName, queueName: 'maintenance', workflowID });
    await handle.getResult({ pollingIntervalMs: 25 });
    return (await client.listWorkflowSteps(workflowID))!.map(({ name, output }) => ({ name, output }));
  }
  try {
    await work.launch();
    const bulk = 'library.collectionBulkExpirySweep';
    const expiry = 'library.collectionBulk.expiryPage';
    expect(await run(bulk)).toEqual([{ name: expiry, output: ROUTES }]);
    for (const kind of [
      'entryIncarnationCutover',
      'labelRetention',
      'labelConsolidationRetention',
      'entryAnnotationCorrectionRetention',
    ]) {
      expect(await run(`library.${kind}Sweep`)).toEqual([
        { name: `library.${kind}Page`, output: { next: null, nextPartition: PARTITIONS } },
      ]);
    }
    const route = ROUTES - 7,
      operation = newId(route);
    await pool.query(
      `INSERT INTO library.bulk_operation(route, operation_id, account_id, request, initiator, creation_receipt,
         source_digest, target_count, phase, admitted_at, expires_at, results_expire_at)
       VALUES ($1, $2, $3, '{}', '{}', '{}', repeat('a', 64), 0, 'preview', now(), now() + interval '5 min', now() + interval '1 day')`,
      [route, operation, newId(route)],
    );
    expect(await run(bulk)).toEqual([
      { name: expiry, output: route + 1 },
      { name: expiry, output: ROUTES },
    ]);
    expect(
      (
        await pool.query('SELECT 1 FROM library.bulk_operation WHERE route = $1 AND operation_id = $2', [
          route,
          operation,
        ])
      ).rowCount,
    ).toBe(1);
  } finally {
    try {
      await work.shutdown();
      await client.close();
    } finally {
      await pool.end();
      await database.close();
    }
  }
}, 120_000);

test('segments resume old local cursors before seeking from the next partition', async () => {
  const seen: [number, string | null][] = [];
  const frontier = await advanceMaintenanceSegment({ partition: 8, after: null }, async (partition, after) => {
    seen.push([partition, after]);
    if (seen.length === 1) return { next: 'retained' };
    if (seen.length === 2) return { next: null };
    return { next: null, nextPartition: PARTITIONS };
  });
  expect(seen).toEqual([
    [8, null],
    [8, 'retained'],
    [9, null],
  ]);
  expect(frontier).toEqual({ partition: PARTITIONS, after: null });
});
