import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { GLOBAL_CONTEXT } from '../../src/access/gates/catalogue.ts';
import { createNativeEconomyDatabase, createNativeEconomyLedger } from '../../src/composition/economy.ts';
import {
  createNativeEconomyTestFunding,
  type EconomyTestFundingBinding,
} from '../../src/composition/economy-test-funding.ts';
import { ECONOMY_TEST_FUNDING_WORK } from '../../src/composition/economy-test-funding-work.ts';
import { createFundingLedgerBinder } from '../../src/economy/storage/funding-ledger.ts';
import { createFundingStore } from '../../src/economy/storage/funding-store.ts';
import { createConfirmedFundingTestRail } from '../../src/economy/storage/funding-test-rail.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { createWorkClient } from '../../src/work/client.ts';
import { openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';
import { workerTestEnv } from '../support/worker-env.ts';
import { openIsolatedEconomyDatabase } from './fixtures/isolated-database.ts';

let db: GrowthDatabase;
let isolated: Awaited<ReturnType<typeof openIsolatedEconomyDatabase>>;
beforeAll(async () => {
  isolated = await openIsolatedEconomyDatabase();
  db = await openGrowthDatabase(isolated.url);
}, 90_000);
afterAll(async () => {
  try {
    await db?.close();
  } finally {
    await isolated?.close();
  }
});

function success<T>(result: { kind: 'ok'; value: T } | { kind: string }): T {
  if (result.kind !== 'ok' || !('value' in result)) throw new Error(`Expected success, received ${result.kind}`);
  return result.value;
}

async function runWorker(environment: 'development' | 'production', target: EconomyTestFundingBinding) {
  const program = `
    import { startWorker, readWorkerConfig } from './src/worker.ts';
    import { createWorkClient } from './src/work/client.ts';
    import { ECONOMY_TEST_FUNDING_WORK as work } from './src/composition/economy-test-funding-work.ts';
    const env = process.env;
    let installed;
    const worker = await startWorker(
      { ...readWorkerConfig(env), handleSignals: false, effectsRelay: false },
      modules => modules.filter(module => module.name === 'economy-test-funding').map(module => ({
        ...module,
        async register(context) {
          await module.register(context);
          installed = await context.client.getSchedule(work.scheduleName);
          if (installed) await context.client.pauseSchedule(work.scheduleName);
        },
      })),
      env,
    );
    const client = await createWorkClient(env.DATABASE_URL);
    try {
      const target = JSON.parse(env.TEST_BINDING);
      const scheduled = installed ? { ...target, namespace: 'retired-test-rail' } : target;
      const job = await client.enqueue({ workflowName: work.workflowName, queueName: 'maintenance' }, new Date(), scheduled);
      const report = {
        installed: installed ?? null,
        stale: await job.getResult(),
        advanced: installed ? await (await client.triggerSchedule(work.scheduleName)).getResult() : null,
      };
      console.log('TEST_FUNDING_WORK_RESULT=' + JSON.stringify(report));
    } finally {
      await client.close();
      await worker.stop();
    }
  `;
  const child = Bun.spawn([process.execPath, '-e', program], {
    cwd: import.meta.dir + '/../..',
    env: workerTestEnv({
      DATABASE_URL: db.url,
      REYLO_CONFIG: process.env.REYLO_CONFIG,
      NODE_ENV: environment,
      TEST_BINDING: JSON.stringify(target),
      KERNEL_ECONOMY_BOOK_ID: target.bookId,
      KERNEL_ECONOMY_NODE: target.node,
      KERNEL_ECONOMY_TEST_FUNDING_ASSET_ID: target.assetId,
      KERNEL_ECONOMY_TEST_FUNDING_NAMESPACE: target.namespace,
      KERNEL_ECONOMY_TEST_FUNDING_MODE: target.mode,
    }),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const timeout = setTimeout(() => child.kill(), 28_000);
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    const prefix = 'TEST_FUNDING_WORK_RESULT=';
    const report = stdout.split('\n').find((line) => line.startsWith(prefix));
    if (code !== 0 || !report) throw new Error(`Worker exited ${code}\n${stdout}\n${stderr}`);
    return JSON.parse(report.slice(prefix.length));
  } finally {
    clearTimeout(timeout);
  }
}

test('a local worker recovers legacy intake and a lost claim while live and obsolete test work stay pending', async () => {
  const { pool } = db;
  const target = {
    bookId: `test-funding-worker:${randomUUID()}`,
    node: 'b',
    assetId: 'synthetic',
    namespace: `test-rail:${randomUUID()}`,
    mode: 'test',
  } as const;
  const accountId = newId(0x6a59);
  const route = routeOf(accountId);
  const ledger = createNativeEconomyLedger(pool, target.bookId);
  const native = createNativeEconomyTestFunding(pool, target);
  const store = createFundingStore(
    createNativeEconomyDatabase(pool),
    target.bookId,
    createFundingLedgerBinder(target.bookId),
  );
  await pool.query(
    "INSERT INTO access.account(route, account_id, kind, state, transaction_id) VALUES ($1, $2, 'actor', 'active', $2)",
    [route, accountId],
  );
  await pool.query(
    `INSERT INTO access.resource_grant (route, resource_id, subject_id, subject_kind, action, valid, transaction_id)
     VALUES (0, $1, $2, 'identity', 'gate:economy', '(,)', $2)`,
    [GLOBAL_CONTEXT.id, accountId],
  );
  for (const id of [target.assetId, 'different-asset'])
    success(await ledger.provisionAsset({ id, scale: 0, transferable: true }));

  const migration = await Bun.file(
    new URL('../../db/economy/migrations/20261121080500_economy_test_funding_lane.sql', import.meta.url),
  ).text();
  const [upgrade, downgrade] = migration.split('-- migrate:down') as [string, string];
  await db.admin.query(downgrade);
  function digest(values: string[]) {
    return createHash('sha256').update(JSON.stringify(values)).digest('hex');
  }
  const legacyDestination = digest(['test-funding-destination', target.bookId, target.namespace, accountId]);
  const legacyIntentId = digest(['test-funding-intent', target.bookId, accountId, 'pre-upgrade']);
  const legacy = {
    bookId: target.bookId,
    walletId: accountId,
    assetId: target.assetId,
    intentId: legacyIntentId,
    direction: 'deposit' as const,
    units: '7',
    provider: { namespace: target.namespace, mode: 'test' as const, destinationRef: legacyDestination },
  };
  expect(success(await store.begin(legacy))).toMatchObject({ kind: 'created' });
  expect(success(await store.prepare(legacyIntentId))).toMatchObject({ kind: 'queued' });

  const unrelated: string[] = [];
  for (let index = 0; index < 19; index++) {
    const intentId = digest(['unrelated', String(index)]);
    unrelated.push(intentId);
    expect(
      success(
        await store.begin({
          bookId: target.bookId,
          walletId: accountId,
          assetId: target.assetId,
          intentId,
          direction: 'deposit',
          units: '1',
          provider: {
            namespace: target.namespace,
            mode: index ? 'live' : 'test',
            destinationRef: index === 1 ? legacyDestination : 'foreign',
          },
        }),
      ),
    ).toMatchObject({ kind: 'created' });
    expect(success(await store.prepare(intentId))).toMatchObject({ kind: 'queued' });
  }
  await db.admin.query(upgrade);
  const lane = await db.admin.query(
    'SELECT intent_id, test_lane FROM economy.funding_dispatch WHERE book_id = $1 AND test_lane IS NOT NULL',
    [target.bookId],
  );
  expect(lane.rows).toEqual([
    {
      intent_id: legacyIntentId,
      test_lane: digest(['test-funding-lane', target.bookId, target.assetId, target.namespace]),
    },
  ]);

  function deposit(operationId: string, amount: string) {
    return { accountId, deadline: Date.now() + 2_000, operationId, direction: 'deposit' as const, amount };
  }
  for (const other of [
    { ...target, assetId: 'different-asset' },
    { ...target, namespace: 'different-namespace' },
  ]) {
    const obsolete = createNativeEconomyTestFunding(pool, other);
    const request = deposit(`different-${other.assetId}-${other.namespace}`, '3');
    unrelated.push((await obsolete.port.begin(request)).intentId);
  }

  const { intentId } = await native.port.begin(deposit('lost-claim', '500'));
  const claimId = randomUUID();
  const claim = success(await store.claim(intentId, claimId));
  if (claim.kind !== 'claimed') throw new Error(`Expected submit claim, received ${claim.kind}`);
  expect(claim.action).toBe('submit');
  const evidence = createConfirmedFundingTestRail(target.namespace).submit(claim.attempt);
  if (evidence.kind !== 'observed' || evidence.observation.kind !== 'confirmed') throw new Error('Missing evidence');
  // Simulate a process loss after creating its observation, before the returned evidence can be acknowledged.
  await pool.query(
    `UPDATE economy.funding_dispatch_claim SET lease_until = statement_timestamp() - interval '2 seconds'
     WHERE book_id = $1 AND intent_id = $2 AND claim_id = $3`,
    [target.bookId, intentId, claimId],
  );
  await pool.query(
    `UPDATE economy.funding_dispatch SET due_at = statement_timestamp() - interval '1 second'
     WHERE book_id = $1 AND intent_id = $2`,
    [target.bookId, intentId],
  );
  const client = await createWorkClient(db.url);
  try {
    expect(await runWorker('development', target)).toMatchObject({
      installed: { schedule: '*/10 * * * * *', queueName: 'maintenance', context: target },
      stale: { kind: 'disabled' },
      advanced: { kind: 'advanced', attempted: 2, acknowledged: 2 },
    });
    expect(success(await store.read(intentId))).toMatchObject({
      phase: 'confirmed',
      confirmedMovementId: evidence.observation.movementId,
    });
    expect(success(await store.read(legacyIntentId))).toMatchObject({ phase: 'confirmed' });
    const claimRows = await pool.query(
      `SELECT action, acknowledgment IS NOT NULL AS acknowledged FROM economy.funding_dispatch_claim
       WHERE book_id = $1 AND intent_id = $2 ORDER BY action DESC`,
      [target.bookId, intentId],
    );
    expect(claimRows.rows).toEqual([
      { action: 'submit', acknowledged: false },
      { action: 'reconcile', acknowledged: true },
    ]);
    const untouched = await pool.query(
      `SELECT count(*)::int AS count FROM economy.funding_dispatch
       WHERE book_id = $1 AND intent_id = ANY($2::text[]) AND active_claim_id IS NULL AND closed_at IS NULL`,
      [target.bookId, unrelated],
    );
    expect(untouched.rows).toEqual([{ count: unrelated.length }]);
    expect(success(await ledger.readBalance({ accountId, assetId: target.assetId })).posted).toBe('507');

    const pending = await native.port.begin(deposit('production-disabled', '25'));
    expect(await runWorker('production', target)).toEqual({
      installed: null,
      stale: { kind: 'disabled' },
      advanced: null,
    });
    expect(success(await store.read(pending.intentId))).toMatchObject({ phase: 'submitted' });
    expect(success(await ledger.readBalance({ accountId, assetId: target.assetId })).posted).toBe('507');
  } finally {
    await client.deleteSchedule(ECONOMY_TEST_FUNDING_WORK.scheduleName);
    await client.close();
  }
}, 75_000);
