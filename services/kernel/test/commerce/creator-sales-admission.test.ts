import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { bindExecutionContract } from '../../src/command/execution-contract.ts';
import { EFFECTS_CONSUMER, relayEffects } from '../../src/events/effects.ts';
import { historyExecutionPort } from '../../src/history/application/index.ts';
import { authoritativeTimeValue, runCommand } from '../../src/command/command.ts';
import { backfillCreatorSales, runCreatorSaleWorkPage } from '../../src/commerce/creator-sales-work.ts';
import { advanceCommerceErasure } from '../../src/commerce/erasure-participant.ts';
import { insertOrder } from '../../src/commerce/store.ts';
import type { Offer } from '../../src/commerce/model.ts';
import type { CloudEvent } from '../../src/events/log.ts';
import { encodeLocator } from '../../src/history/contract/locator.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { createWorkClient } from '../../src/work/client.ts';
import { composeWork, type WorkContext } from '../../src/work/registry.ts';
import { workExecutionPort } from '../../src/work/selected-runtime.ts';
import { commerceWorkModule } from '../../src/commerce/work-module.ts';
import { nativeFixture } from '../access/native-account-bindings-fixture.ts';
import { deletePersona } from '../support/account-deletion.ts';
import { openGrowthDatabase } from '../support/growth.ts';
import { createPersonas } from '../support/personas.ts';
import { testKernel } from '../support/test-kernel.ts';

let db: Awaited<ReturnType<typeof openGrowthDatabase>>;
let auth: Awaited<ReturnType<typeof nativeFixture>>;
let people: Awaited<ReturnType<typeof createPersonas>>;
let worker: Awaited<ReturnType<typeof composeWork>>;
let workerStopped = false;
let client: Awaited<ReturnType<typeof createWorkClient>>;
let context: WorkContext;

type OriginalRole = {
  partition_no: number;
  account_route: number;
  account_id: string;
  artifact_type: string;
  locator: Buffer;
  roles: number;
  minimizer_version: number;
  state: string;
  proof_barrier: string | null;
};

function orderId(route: number, prefix: string) {
  return `${prefix}-0000-7000-8000-${route.toString(16).padStart(4, '0')}00000000`;
}

function eventLocator(event: CloudEvent) {
  const partition = Number(/^urn:rezics:log:(\d+)\./.exec(event.source)?.[1]);
  return {
    partition,
    locator: Buffer.from(
      encodeLocator({
        artifactType: 'outbox-event/v1',
        partitionNo: partition,
        position: BigInt(event.sequence),
        eventSeq: 0,
      }),
    ),
  };
}

async function seed(
  creatorAccountId: string,
  buyerAccountId: string,
  options: { orderId?: string; delegated?: boolean } = {},
) {
  const route = routeOf(buyerAccountId)!;
  const offer: Offer = {
    id: newId(routeOf(creatorAccountId)!),
    creatorAccountId,
    targetSubjectId: newId(0x5500),
    title: 'Captured recovery title',
    currency: 'usd',
    unitAmountMinor: 1200,
    taxCode: 'txcd_10302000',
    royaltyBasisPoints: 9000,
    state: 'active',
    revision: 1,
    contentEdition: null,
  };
  const requestedBy = options.delegated
    ? `urn:rezics:request:${creatorAccountId}:${newId(routeOf(creatorAccountId)!)}`
    : null;
  const id = options.orderId ?? newId(route);
  const result = await runCommand(
    db.pool,
    {
      partition: partitionOf(route),
      basis: { actorAccountId: buyerAccountId, clientId: 'creator-sale-admission-fixture', requestedBy },
    },
    async (tx, command) => ({
      value: await insertOrder(
        tx,
        route,
        { id, buyerAccountId, offer },
        { transactionId: command.transactionId, time: authoritativeTimeValue(command.time) },
      ),
      events: [
        {
          type: 'com.rezics.commerce.order.created.v1',
          subject: id,
          data: { orderId: id },
        },
      ],
    }),
  );
  const event = await eventAt(partitionOf(route), result.position);
  if (options.delegated) await ensureOriginalRoleEvidence(event, buyerAccountId);
  return { order: result.value, event };
}

async function eventAt(partition: number, position: bigint): Promise<CloudEvent> {
  const row = (
    await db.pool.query<{ id: string; type: string; subject: string; data: unknown; epoch: number }>(
      'SELECT id,type,subject,data,epoch FROM core.outbox WHERE partition_no=$1 AND position=$2 AND event_seq=0',
      [partition, position.toString()],
    )
  ).rows[0]!;
  return {
    specversion: '1.0',
    id: row.id,
    type: row.type,
    subject: row.subject,
    data: row.data,
    source: `urn:rezics:log:${partition}.${row.epoch}`,
    time: new Date().toISOString(),
    datacontenttype: 'application/json',
    sequence: position.toString().padStart(19, '0'),
  };
}

async function ensureOriginalRoleEvidence(event: CloudEvent, accountId: string) {
  const { partition, locator } = eventLocator(event);
  await db.pool.query(
    `INSERT INTO core.history_locator
       (partition_no,account_route,account_id,artifact_type,locator,roles,minimizer_version,state,proof_barrier)
     VALUES($1,$2,$3,'outbox-event/v1',$4,1,1,'pending',NULL) ON CONFLICT DO NOTHING`,
    [partition, routeOf(accountId), accountId, locator],
  );
}

async function removeOriginalRoleEvidence(event: CloudEvent) {
  const { partition, locator } = eventLocator(event);
  const roles = (
    await db.pool.query<OriginalRole>(
      `DELETE FROM core.history_locator
       WHERE partition_no=$1 AND artifact_type='outbox-event/v1' AND locator=$2
       RETURNING partition_no,account_route,account_id,artifact_type,locator,roles,minimizer_version,state,proof_barrier`,
      [partition, locator],
    )
  ).rows;
  expect(roles.length).toBeGreaterThan(0);
  return roles;
}

async function restoreOriginalRoleEvidence(roles: OriginalRole[]) {
  for (const row of roles)
    await db.pool.query(
      `INSERT INTO core.history_locator
       (partition_no,account_route,account_id,artifact_type,locator,roles,minimizer_version,state,proof_barrier)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING`,
      [
        row.partition_no,
        row.account_route,
        row.account_id,
        row.artifact_type,
        row.locator,
        row.roles,
        row.minimizer_version,
        row.state,
        row.proof_barrier,
      ],
    );
}

async function relayThrough(partition: number, position: bigint) {
  for (;;) {
    const result = await relayEffects(db.pool, worker.effects, partition);
    if (result.status !== 'read') throw new Error(`Creator sale effects relay stopped: ${result.status}`);
    const checkpoint = (
      await db.pool.query<{ position: string }>(
        'SELECT position::text FROM core.consumer_checkpoint WHERE partition_no=$1 AND consumer=$2',
        [partition, EFFECTS_CONSUMER],
      )
    ).rows[0];
    if (checkpoint && BigInt(checkpoint.position) >= position) return;
    if (result.envelopes === 0) throw new Error('Creator sale effects checkpoint stopped before the test event');
  }
}

async function admit(event: CloudEvent) {
  const partition = Number(/^urn:rezics:log:(\d+)\./.exec(event.source)?.[1]);
  await relayThrough(partition, BigInt(event.sequence));
}

async function replay(event: CloudEvent) {
  const source = /^urn:rezics:log:(\d+)\.(\d+)$/.exec(event.source);
  if (!source) throw new Error('Invalid native fixture event source');
  await db.pool.query(
    `UPDATE core.consumer_checkpoint SET epoch=$3,position=$4
     WHERE partition_no=$1 AND consumer=$2`,
    [Number(source[1]), EFFECTS_CONSUMER, Number(source[2]), (BigInt(event.sequence) - 1n).toString()],
  );
  await admit(event);
}

async function page(partition: number) {
  return runCreatorSaleWorkPage(context, {
    accounts: [],
    partition,
    root: 'creator-sales-admission-test',
    segment: 0,
  });
}

async function checkpointEffectsThroughCurrentHead(partition: number) {
  const head = (
    await db.pool.query<{ epoch: number; position: string }>(
      'SELECT epoch,position::text FROM core.partition WHERE partition_no=$1',
      [partition],
    )
  ).rows[0]!;
  await db.pool.query(
    `INSERT INTO core.consumer_checkpoint(partition_no,consumer,epoch,position)
     VALUES($1,$2,$3,$4)
     ON CONFLICT(partition_no,consumer) DO UPDATE SET epoch=EXCLUDED.epoch,position=EXCLUDED.position`,
    [partition, EFFECTS_CONSUMER, head.epoch, head.position],
  );
}

async function readReceipt(event: CloudEvent) {
  const partition = Number(/^urn:rezics:log:(\d+)\./.exec(event.source)?.[1]);
  return db.pool.query(
    `SELECT partition_no,position::text,event_seq,epoch::text,route,event_id,order_id,source_revision,state
     FROM commerce.creator_sale_receipt WHERE partition_no=$1 AND position=$2 AND event_seq=0`,
    [partition, BigInt(event.sequence).toString()],
  );
}

async function liveCopyInventoryCount(events: CloudEvent[], orders: string[]) {
  const first = eventLocator(events[0]!);
  const positions = events.map((event) => BigInt(event.sequence).toString());
  return (
    await db.pool.query<{ n: number }>(
      `SELECT count(*)::integer AS n FROM access.live_copy_business_inventory
       WHERE (kind='commerce-receipt' AND locator->>'partition'=$1 AND locator->>'position'=ANY($2::text[]))
          OR (kind='commerce-work' AND locator->>'orderId'=ANY($3::text[]))`,
      [String(first.partition), positions, orders],
    )
  ).rows[0]!.n;
}

beforeAll(async () => {
  db = await openGrowthDatabase();
  auth = await nativeFixture(db.pool);
  const service = auth.host.service;
  const app = testKernel({
    pool: db.pool,
    auth: { ...service.verifier, fetch: (url, init) => service.handler(new Request(url, init)) },
    writeRate: createWriteRateLimiter({ secret: 'creator-sale-admission-native-fixture-secret' }),
  });
  people = await createPersonas(app, { version: 1, pool: db.pool, auth });
  // Auth and Commerce share DBOS's process-global runtime. Keep Auth stopped while
  // the Commerce worker owns it; restart Auth only for the terminal deletion below.
  await auth.stop();
  client = await createWorkClient(db.url, db.pool);
  bindExecutionContract(client, workExecutionPort(), historyExecutionPort);
  worker = await composeWork(
    [
      {
        name: 'capture_creator_sale_admission_context',
        register(value) {
          context = value;
        },
      },
      commerceWorkModule,
    ],
    { pool: db.pool, client, databaseUrl: db.url, env: {} },
  );
}, 120_000);

afterAll(async () => {
  if (!workerStopped) await worker?.shutdown();
  await client?.close();
  await auth?.close();
  await db?.close();
});

test('exact event recovery survives a covered frontier, replay and terminal buyer erasure', async () => {
  const buyer = people.bob.accountId;
  const route = routeOf(buyer)!;
  const home = partitionOf(route);
  await checkpointEffectsThroughCurrentHead(home);

  const anchor = await seed(people.alice.accountId, buyer, { orderId: orderId(route, '20000000') });
  await admit(anchor.event);
  expect(await backfillCreatorSales(context, home)).toBe(true);
  expect(
    (await db.pool.query('SELECT phase FROM commerce.creator_sales_frontier WHERE partition_no=$1', [home])).rows,
  ).toEqual([{ phase: 'covered' }]);
  expect(await page(home)).toBe(true);
  expect(
    (await db.pool.query('SELECT order_id FROM commerce.creator_sale WHERE order_id=$1', [anchor.order.id])).rows,
  ).toHaveLength(1);

  // Both new events arrive after the keyset is covered: one sorts ahead and one behind it.
  const ahead = await seed(people.alice.accountId, buyer, {
    orderId: orderId(route, 'f0000000'),
    delegated: true,
  });
  const aheadRoles = await removeOriginalRoleEvidence(ahead.event);
  await admit(ahead.event);
  const behind = await seed(people.alice.accountId, buyer, {
    orderId: orderId(route, '10000000'),
    delegated: true,
  });
  const behindRoles = await removeOriginalRoleEvidence(behind.event);
  await admit(behind.event);
  expect(ahead.order.id > anchor.order.id).toBe(true);
  expect(behind.order.id < anchor.order.id).toBe(true);

  const partition = home;
  const recovery = (
    await db.pool.query(
      `SELECT partition_no,position::text,event_seq,epoch::text,event_id,event_type
       FROM commerce.creator_sale_admission_recovery WHERE partition_no=$1 ORDER BY position`,
      [partition],
    )
  ).rows;
  expect(recovery).toEqual(
    [ahead.event, behind.event].map((event) => ({
      partition_no: partition,
      position: BigInt(event.sequence).toString(),
      event_seq: 0,
      epoch: /^urn:rezics:log:\d+\.(\d+)$/.exec(event.source)?.[1],
      event_id: event.id,
      event_type: event.type,
    })),
  );
  expect(
    (
      await db.pool.query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema='commerce' AND table_name='creator_sale_admission_recovery'
         ORDER BY ordinal_position`,
      )
    ).rows,
  ).toEqual(
    ['partition_no', 'position', 'event_seq', 'epoch', 'event_id', 'event_type', 'retry_at'].map((column_name) => ({
      column_name,
    })),
  );
  expect((await readReceipt(ahead.event)).rows).toEqual([]);
  expect((await readReceipt(behind.event)).rows).toEqual([]);
  expect(
    (
      await db.pool.query(
        `SELECT count(*)::integer AS n FROM commerce.creator_sale_work
         WHERE order_id=ANY($1::uuid[])`,
        [[ahead.order.id, behind.order.id]],
      )
    ).rows,
  ).toEqual([{ n: 0 }]);
  expect(await liveCopyInventoryCount([ahead.event, behind.event], [ahead.order.id, behind.order.id])).toBe(0);

  // Replay cannot multiply the exact key. Each missing role retries independently and backs off.
  await replay(ahead.event);
  expect(
    (
      await db.pool.query(
        `SELECT count(*)::integer AS n FROM commerce.creator_sale_admission_recovery
         WHERE event_id=ANY($1::uuid[])`,
        [[ahead.event.id, behind.event.id]],
      )
    ).rows,
  ).toEqual([{ n: 2 }]);
  await db.pool.query(
    `UPDATE commerce.creator_sale_admission_recovery SET retry_at=now()
     WHERE event_id=ANY($1::uuid[])`,
    [[ahead.event.id, behind.event.id]],
  );
  expect(await page(home)).toBe(true);
  expect(await page(home)).toBe(true);
  expect(
    (
      await db.pool.query(
        `SELECT count(*)::integer AS n FROM commerce.creator_sale_admission_recovery
         WHERE event_id=ANY($1::uuid[]) AND retry_at>now()`,
        [[ahead.event.id, behind.event.id]],
      )
    ).rows,
  ).toEqual([{ n: 2 }]);

  // A later independent native event still reaches the ordinary default receiver.
  const later = await seed(people.alice.accountId, buyer, { orderId: orderId(route, 'f1000000') });
  await admit(later.event);
  expect(await page(home)).toBe(true);
  expect(
    (await db.pool.query('SELECT order_id FROM commerce.creator_sale WHERE order_id=$1', [later.order.id])).rows,
  ).toHaveLength(1);
  expect(
    (await db.pool.query('SELECT phase FROM commerce.creator_sales_frontier WHERE partition_no=$1', [home])).rows,
  ).toEqual([{ phase: 'covered' }]);

  await restoreOriginalRoleEvidence(aheadRoles);
  await restoreOriginalRoleEvidence(behindRoles);
  await db.pool.query(
    `UPDATE commerce.creator_sale_admission_recovery SET retry_at=now()
     WHERE event_id=ANY($1::uuid[])`,
    [[ahead.event.id, behind.event.id]],
  );
  expect(await page(home)).toBe(true); // first recovery re-enters ordinary exact-event admission
  expect(await page(home)).toBe(true); // the second is independent and separately bounded
  expect(await page(home)).toBe(true); // ordinary creator projection for one admitted receipt
  expect(await page(home)).toBe(true); // ordinary creator projection for the other admitted receipt

  for (const item of [ahead, behind]) {
    expect((await readReceipt(item.event)).rows).toEqual([
      {
        partition_no: home,
        position: BigInt(item.event.sequence).toString(),
        event_seq: 0,
        epoch: /^urn:rezics:log:\d+\.(\d+)$/.exec(item.event.source)?.[1],
        route,
        event_id: item.event.id,
        order_id: item.order.id,
        source_revision: 1,
        state: 'pending',
      },
    ]);
    expect(
      (await db.pool.query('SELECT order_id FROM commerce.creator_sale WHERE order_id=$1', [item.order.id])).rows,
    ).toHaveLength(1);
  }
  expect(
    (
      await db.pool.query(
        `SELECT count(*)::integer AS n FROM commerce.creator_sale_admission_recovery
         WHERE event_id=ANY($1::uuid[])`,
        [[ahead.event.id, behind.event.id]],
      )
    ).rows,
  ).toEqual([{ n: 0 }]);
  const inventoryCount = await liveCopyInventoryCount([ahead.event, behind.event], [ahead.order.id, behind.order.id]);
  expect(inventoryCount).toBeGreaterThan(0);
  for (const item of [ahead, behind]) await replay(item.event);
  expect(
    (
      await db.pool.query(
        `SELECT count(*)::integer AS n FROM commerce.creator_sale_receipt
         WHERE event_id=ANY($1::uuid[])`,
        [[ahead.event.id, behind.event.id]],
      )
    ).rows,
  ).toEqual([{ n: 2 }]);
  expect(
    (
      await db.pool.query(
        `SELECT count(*)::integer AS n FROM commerce.creator_sale
         WHERE order_id=ANY($1::uuid[])`,
        [[ahead.order.id, behind.order.id]],
      )
    ).rows,
  ).toEqual([{ n: 2 }]);
  expect(await liveCopyInventoryCount([ahead.event, behind.event], [ahead.order.id, behind.order.id])).toBe(
    inventoryCount,
  );

  // Terminal deletion during the gap is resolved by the same original producer and stays
  // under Commerce's existing financial/shared-custody erasure result.
  const terminalHome = partitionOf(routeOf(people.staff.accountId)!);
  await checkpointEffectsThroughCurrentHead(terminalHome);
  const terminal = await seed(people.alice.accountId, people.staff.accountId, { delegated: true });
  await removeOriginalRoleEvidence(terminal.event);
  await admit(terminal.event);
  expect((await readReceipt(terminal.event)).rows).toEqual([]);
  await worker.shutdown();
  workerStopped = true;
  await auth.restart();
  await deletePersona({ pool: db.pool, auth }, people.staff);
  await auth.stop();
  await db.pool.query('UPDATE commerce.creator_sale_admission_recovery SET retry_at=now() WHERE event_id=$1', [
    terminal.event.id,
  ]);
  expect(await page(terminalHome)).toBe(true);
  let progress = await advanceCommerceErasure(db.pool, people.staff.accountId);
  while (progress === 'more') progress = await advanceCommerceErasure(db.pool, people.staff.accountId);
  expect(progress).toBe('pending');
  expect((await readReceipt(terminal.event)).rows).toEqual([
    {
      partition_no: terminalHome,
      position: BigInt(terminal.event.sequence).toString(),
      event_seq: 0,
      epoch: /^urn:rezics:log:\d+\.(\d+)$/.exec(terminal.event.source)?.[1],
      route: routeOf(terminal.order.id),
      event_id: terminal.event.id,
      order_id: null,
      source_revision: null,
      state: 'minimized',
    },
  ]);
  expect(
    (await db.pool.query('SELECT order_id FROM commerce.creator_sale_work WHERE order_id=$1', [terminal.order.id]))
      .rows,
  ).toHaveLength(0);
  expect(
    (await db.pool.query('SELECT order_id FROM commerce.creator_sale WHERE order_id=$1', [terminal.order.id])).rows,
  ).toHaveLength(0);
  expect(
    (
      await db.pool.query('SELECT 1 FROM commerce.creator_sale_admission_recovery WHERE event_id=$1', [
        terminal.event.id,
      ])
    ).rows,
  ).toEqual([]);
  expect(
    (
      await db.pool.query(
        "SELECT outcome FROM access.erasure_acknowledgement WHERE route=$1 AND account_id=$2 AND participant='commerce'",
        [routeOf(people.staff.accountId), people.staff.accountId],
      )
    ).rows,
  ).toEqual([]);
});
