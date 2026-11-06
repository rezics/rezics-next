import { insertCollection, insertMember, tombstoneCollection } from '../../src/library/collection-store.ts';
import { syncSubjectListing, recoverSubjectListing } from '../../src/library/listing.ts';
import { admitListingSource } from '../../src/library/listing-source-observer.ts';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { nativeFixture } from './native-account-bindings-fixture.ts';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import {
  admitLiveCopyRoles,
  observeLiveCopyAdmissions,
  openLiveCopyGate,
  finishLiveCopyGate,
  cancelLiveCopy,
  consumeLiveCopy,
  liveCopyLocator,
  readLiveCopyResult,
} from '../../src/access/live-copy.ts';
import { authoritativeTimeValue, runCommand } from '../../src/command/command.ts';
import { runOperationalTransaction } from '../../src/command/operational.ts';
import {
  admitCreatorSale,
  advanceCreatorSale,
  prepareCreatorSaleDelivery,
  recoverCreatorSale,
  readCreatorSaleSource,
  writeCreatorSaleProjection,
} from '../../src/commerce/creator-sales-work.ts';
import { commerceWorkModule } from '../../src/commerce/work-module.ts';
import { createCommerceCommands } from '../../src/commerce/commands.ts';
import { insertOrder } from '../../src/commerce/store.ts';
import type { Offer } from '../../src/commerce/model.ts';
import type { CloudEvent } from '../../src/events/log.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { createWorkClient } from '../../src/work/client.ts';
import { composeWork, type WorkContext } from '../../src/work/registry.ts';
import { openGrowthDatabase } from '../support/growth.ts';
import { createPersonas } from '../support/personas.ts';
import { testKernel } from '../support/test-kernel.ts';
import { deletePersona } from '../support/account-deletion.ts';

let db: Awaited<ReturnType<typeof openGrowthDatabase>>;
let auth: Awaited<ReturnType<typeof nativeFixture>>;
let app: ReturnType<typeof testKernel>;
let people: Awaited<ReturnType<typeof createPersonas>>;
let client: Awaited<ReturnType<typeof createWorkClient>>;
let worker: Awaited<ReturnType<typeof composeWork>>;
let context: WorkContext;
beforeAll(async () => {
  db = await openGrowthDatabase();
  auth = await nativeFixture(db.pool);
  const service = auth.host.service;
  app = testKernel({
    pool: db.pool,
    auth: { ...service.verifier, fetch: (url, init) => service.handler(new Request(url, init)) },
    writeRate: createWriteRateLimiter({ secret: 'live-copy-real-native-source-fixture' }),
  });
  people = await createPersonas(app, { version: 1, pool: db.pool, auth });
  client = await createWorkClient(db.url, db.pool);
  worker = await composeWork(
    [
      {
        name: 'capture_native_context',
        register(value) {
          context = value;
        },
      },
      commerceWorkModule,
    ],
    { pool: db.pool, client, databaseUrl: db.url, env: {} },
  );
  const opened = await app.handle(
    new Request('http://kernel.test/v1/platform/exposure/selling:open', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${people.staff.bearer}`,
        'content-type': 'application/json',
        'idempotency-key': JSON.stringify(crypto.randomUUID()),
      },
      body: '{}',
    }),
  );
  expect(opened.status).toBe(200);
}, 120000);
afterAll(async () => {
  await worker?.shutdown();
  await client?.close();
  await auth?.close();
  await db?.close();
});
async function seed(buyer = people.bob.accountId) {
  const creator = people.alice.accountId,
    route = routeOf(buyer)!;
  const offer: Offer = {
    id: newId(routeOf(creator)!),
    creatorAccountId: creator,
    targetSubjectId: newId(0x5500),
    title: 'Native held sale',
    currency: 'usd',
    unitAmountMinor: 1200,
    taxCode: 'txcd_10302000',
    royaltyBasisPoints: 9000,
    state: 'active',
    revision: 1,
    contentEdition: null,
  };
  const id = newId(route);
  const source = await runCommand(
    db.pool,
    {
      partition: partitionOf(route),
      basis: { actorAccountId: buyer, clientId: 'native-live-copy-fixture', requestedBy: null },
    },
    async (tx, command) => ({
      value: await insertOrder(
        tx,
        route,
        { id, buyerAccountId: buyer, offer },
        { transactionId: command.transactionId, time: authoritativeTimeValue(command.time) },
      ),
      events: [{ type: 'com.rezics.commerce.order.created.v1', subject: id, data: { orderId: id } }],
    }),
  );
  const event = await nativeEvent(route, source.position);
  await runOperationalTransaction(
    db.pool,
    {
      mode: 'work-step',
      partition: partitionOf(route),
      kind: 'commerce.creatorSales.admitFixture',
      accounts: [],
      workClient: client,
    },
    (tx) => admitCreatorSale(tx, event),
  );
  return { locator: { route, orderId: id }, event, creator };
}
async function nativeEvent(route: number, position: bigint) {
  const row = (
    await db.pool.query(
      'SELECT id,type,subject,data,epoch FROM core.outbox WHERE partition_no=$1 AND position=$2 AND event_seq=0',
      [partitionOf(route), position.toString()],
    )
  ).rows[0]!;
  const event: CloudEvent = {
    specversion: '1.0',
    id: row.id,
    type: row.type,
    subject: row.subject,
    data: row.data,
    source: `urn:rezics:log:${partitionOf(route)}.${row.epoch}`,
    sequence: position.toString().padStart(19, '0'),
    time: new Date().toISOString(),
    datacontenttype: 'application/json',
  };
  return event;
}
async function librarySource(curator = people.alice.accountId, visibility: 'public' | 'private' = 'public') {
  const route = routeOf(curator)!,
    collectionId = newId(route),
    subjectId = newId(0x5500);
  await runCommand(
    db.pool,
    {
      partition: partitionOf(route),
      basis: { actorAccountId: curator, clientId: 'native-listing-source-fixture', requestedBy: null },
    },
    async (tx, command) => {
      const write = { transactionId: command.transactionId, time: authoritativeTimeValue(command.time) };
      await insertCollection(
        tx,
        route,
        { id: collectionId, curatorAccountId: curator, title: 'Held public Collection', description: null, visibility },
        write,
      );
      await insertMember(tx, route, collectionId, { id: newId(route), subjectId, note: null, ordinalKey: 'a0' }, write);
      return {
        value: null,
        events: [
          { type: 'com.rezics.library.collection.listing.changed.v1', subject: collectionId, data: { collectionId } },
        ],
      };
    },
  );
  return { collectionId, subjectId };
}
async function removeListing(pair: { collectionId: string; subjectId: string }, curator: string) {
  await runCommand(
    db.pool,
    {
      partition: partitionOf(routeOf(pair.collectionId)!),
      basis: { actorAccountId: curator, clientId: 'native-listing-source-fixture', requestedBy: null },
    },
    async (tx, command) => {
      await tombstoneCollection(tx, routeOf(pair.collectionId)!, pair.collectionId, {
        transactionId: command.transactionId,
        time: authoritativeTimeValue(command.time),
      });
      return {
        value: null,
        events: [
          {
            type: 'com.rezics.library.collection.listing.changed.v1',
            subject: pair.collectionId,
            data: { collectionId: pair.collectionId },
          },
        ],
      };
    },
  );
}
const receiving = (creator: string, body: Parameters<typeof runOperationalTransaction>[2]) =>
  runOperationalTransaction(
    db.pool,
    {
      mode: 'work-step',
      partition: partitionOf(routeOf(creator)!),
      kind: 'commerce.creatorSales.receiveFixture',
      accounts: [],
      workClient: client,
    },
    body,
  );
async function rows(orderId: string) {
  return (
    await db.pool.query(
      'SELECT * FROM commerce.creator_sale WHERE route=$1 AND creator_account_id=$2 AND order_id=$3',
      [routeOf(people.alice.accountId), people.alice.accountId, orderId],
    )
  ).rows;
}

test.serial(
  'The default native creator-sales and foreign Library-copy paths apply each exact admitted transition at most once, remain private, and cannot revive personal payload across account deletion',
  async () => {
    const source = await seed();
    await advanceCreatorSale(context, source.locator);
    const before = await rows(source.locator.orderId);
    expect(before).toHaveLength(1);
    await advanceCreatorSale(context, source.locator);
    expect(await rows(source.locator.orderId)).toEqual(before);
    // The real internal financial writer has a native receipt, intentionally no actor basis.
    const update = await createCommerceCommands({
      clock: () => new Date(),
      pool: db.pool,
      access: app.testAccess,
    }).recordCheckout(source.locator.orderId, { kind: 'failed' });
    if (!('position' in update)) throw new Error('Expected actual committed checkout update');
    expect(
      (
        await db.pool.query('SELECT 1 FROM editorial.write_basis WHERE partition_no=$1 AND transaction_id=$2', [
          partitionOf(source.locator.route),
          update.transactionId,
        ])
      ).rows,
    ).toEqual([]);
    const updated = await nativeEvent(source.locator.route, update.position);
    await runOperationalTransaction(
      db.pool,
      {
        mode: 'work-step',
        partition: partitionOf(source.locator.route),
        kind: 'commerce.creatorSales.admitFixture',
        accounts: [],
        workClient: client,
      },
      (tx) => admitCreatorSale(tx, updated),
    );
    await advanceCreatorSale(context, source.locator);
    expect((await rows(source.locator.orderId))[0]).toMatchObject({ settlement: 'failed', source_revision: 2 });
    const response = await app.handle(
      new Request('http://kernel.test/v1/commerceSales', {
        headers: { authorization: `Bearer ${people.alice.bearer}` },
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    const page = await response.json();
    const sale = page.sales.find((value: { orderId: string }) => value.orderId === source.locator.orderId);
    expect(Object.keys(sale).sort()).toEqual([
      'createdAt',
      'currency',
      'moneyUnit',
      'offerId',
      'orderId',
      'settlement',
      'targetSubjectId',
      'taxBehavior',
      'title',
      'unitAmountMinor',
    ]);
    expect(JSON.stringify(sale)).not.toContain(people.bob.accountId);
    expect(page.projectionState).toBe('preparing');
    const pair = await librarySource();
    await syncSubjectListing(context, pair);
    const native = (
      await db.pool.query(
        'SELECT * FROM library.subject_collection WHERE route=$1 AND subject_id=$2 AND collection_id=$3',
        [routeOf(pair.subjectId), pair.subjectId, pair.collectionId],
      )
    ).rows;
    expect(native).toHaveLength(1);
    await expect(
      db.pool.query(
        'UPDATE library.subject_collection SET multiplicity=multiplicity+1 WHERE route=$1 AND subject_id=$2 AND collection_id=$3',
        [routeOf(pair.subjectId), pair.subjectId, pair.collectionId],
      ),
    ).rejects.toThrow('Listing write requires native live receiving gate');
    const privatePair = await librarySource(people.alice.accountId, 'private');
    await syncSubjectListing(context, privatePair);
    expect(
      (
        await db.pool.query("SELECT 1 FROM access.live_copy_gate WHERE route=$1 AND payload->>'collectionId'=$2", [
          routeOf(privatePair.subjectId),
          privatePair.collectionId,
        ])
      ).rows,
    ).toEqual([]);
    expect(
      (
        await db.pool.query(
          'SELECT 1 FROM library.subject_collection_version WHERE route=$1 AND subject_id=$2 AND collection_id=$3',
          [routeOf(privatePair.subjectId), privatePair.subjectId, privatePair.collectionId],
        )
      ).rows,
    ).toEqual([]);
    await syncSubjectListing(context, pair);
    expect(
      (
        await db.pool.query(
          'SELECT * FROM library.subject_collection WHERE route=$1 AND subject_id=$2 AND collection_id=$3',
          [routeOf(pair.subjectId), pair.subjectId, pair.collectionId],
        )
      ).rows,
    ).toEqual(native);
    expect(
      (
        await db.pool.query(
          'SELECT public_collection_count FROM library.subject_listing WHERE route=$1 AND subject_id=$2',
          [routeOf(pair.subjectId), pair.subjectId],
        )
      ).rows,
    ).toEqual([{ public_collection_count: 1 }]);
    const controlsBefore = (
      await db.pool.query(
        `SELECT count(*)::integer AS n FROM access.live_copy_transition
    WHERE module='library.subject-listing' AND payload->>'collectionId'=$1`,
        [pair.collectionId],
      )
    ).rows;
    await removeListing(pair, people.alice.accountId);
    await syncSubjectListing(context, pair);
    await syncSubjectListing(context, pair);
    expect(
      (
        await db.pool.query(
          `SELECT count(*)::integer AS n FROM access.live_copy_transition
    WHERE module='library.subject-listing' AND payload->>'collectionId'=$1`,
          [pair.collectionId],
        )
      ).rows,
    ).toEqual(controlsBefore);
    expect(
      (
        await db.pool.query(
          'SELECT multiplicity FROM library.subject_collection_version WHERE route=$1 AND subject_id=$2 AND collection_id=$3',
          [routeOf(pair.subjectId), pair.subjectId, pair.collectionId],
        )
      ).rows,
    ).toEqual([{ multiplicity: 0 }]);
    expect(
      (
        await db.pool.query(
          'SELECT public_collection_count FROM library.subject_listing WHERE route=$1 AND subject_id=$2',
          [routeOf(pair.subjectId), pair.subjectId],
        )
      ).rows,
    ).toEqual([{ public_collection_count: 0 }]);
  },
  120000,
);

test.serial(
  'a pending actual delivery cannot activate a different receiver incarnation or rewrite its immutable payload',
  async () => {
    const source = await seed();
    const copy = (await prepareCreatorSaleDelivery(context, source.locator, source.creator))!;
    const home = partitionOf(copy.receiver_route);
    const before = (
      await db.pool.query('SELECT node,epoch,write_state FROM core.partition WHERE partition_no=$1', [home])
    ).rows;
    await expect(
      db.pool.query('UPDATE core.partition SET epoch=epoch+1 WHERE partition_no=$1', [home]),
    ).rejects.toThrow('Live copy domain requires native lineage reconciliation before activation');
    expect(
      (await db.pool.query('SELECT node,epoch,write_state FROM core.partition WHERE partition_no=$1', [home])).rows,
    ).toEqual(before);
    await expect(
      db.pool.query(
        "UPDATE access.live_copy_transition SET payload=jsonb_set(payload,'{title}','\"Conflicting payload\"'::jsonb) WHERE route=$1 AND transition_id=$2",
        [copy.route, copy.transition_id],
      ),
    ).rejects.toThrow('Live copy original source and effect are immutable');
    expect(await readLiveCopyResult(db.pool, copy)).toBeNull();
    await recoverCreatorSale(context, liveCopyLocator(copy));
    expect(await readLiveCopyResult(db.pool, copy)).toMatchObject({ outcome: 'applied' });
    expect((await rows(source.locator.orderId))[0].title).toBe('Native held sale');
  },
  120000,
);

test.serial(
  'a crash after the native receiving commit recovers only exact consume, without rewriting the sale',
  async () => {
    const source = await seed();
    const copy = (await prepareCreatorSaleDelivery(context, source.locator, source.creator))!;
    expect(await admitLiveCopyRoles(context, copy)).toBe(true);
    const proof = await observeLiveCopyAdmissions(db.pool, copy);
    expect(proof).not.toBeNull();
    const fresh = (await readCreatorSaleSource(db.pool, source.locator))!;
    await receiving(source.creator, async (tx) => {
      expect(await openLiveCopyGate(tx, copy, proof)).toBeNull();
      await writeCreatorSaleProjection(tx, fresh);
      await finishLiveCopyGate(tx, copy, 'applied');
    });
    const before = await rows(source.locator.orderId),
      terminal = await readLiveCopyResult(db.pool, copy);
    await expect(
      db.pool.query("UPDATE access.account SET state='deleted' WHERE route=$1 AND account_id=$2", [
        routeOf(people.bob.accountId),
        people.bob.accountId,
      ]),
    ).rejects.toThrow('Unresolved account responsibility');
    await recoverCreatorSale(context, liveCopyLocator(copy));
    await recoverCreatorSale(context, liveCopyLocator(copy));
    expect(await rows(source.locator.orderId)).toEqual(before);
    expect(await readLiveCopyResult(db.pool, copy)).toEqual(terminal);
    expect(
      (
        await db.pool.query(
          "SELECT 1 FROM access.live_copy_hold h JOIN access.lifecycle_coordination c USING(route,account_id,reservation_id) WHERE h.transition_id=$1 AND c.purpose='live-copy'",
          [copy.transition_id],
        )
      ).rows,
    ).toEqual([]);
    expect(
      (
        await db.pool.query(
          "SELECT DISTINCT account_id FROM access.live_copy_inventory WHERE source_domain=$1 AND transition_id=$2 AND item='receiver' ORDER BY account_id",
          [copy.source_domain, copy.transition_id],
        )
      ).rows
        .map((r) => r.account_id)
        .sort(),
    ).toEqual([people.alice.accountId, people.bob.accountId].sort());
  },
  120000,
);

test.serial(
  'cancel wins before first apply and a delayed genuine admission cannot recreate payload after terminal T',
  async () => {
    const source = await seed();
    const copy = (await prepareCreatorSaleDelivery(context, source.locator, source.creator))!;
    expect(await admitLiveCopyRoles(context, copy)).toBe(true);
    const proof = await observeLiveCopyAdmissions(db.pool, copy);
    const cancelled = await cancelLiveCopy(context, copy);
    expect(cancelled.outcome).toBe('cancelled');
    await consumeLiveCopy(context, copy);
    const pair = await librarySource(people.bob.accountId);
    const listing = (await admitListingSource(context, pair))!;
    expect(await admitLiveCopyRoles(context, listing)).toBe(true);
    await cancelLiveCopy(context, listing);
    await consumeLiveCopy(context, listing);
    await removeListing(pair, people.bob.accountId);
    await deletePersona({ pool: db.pool, auth }, people.bob);
    await syncSubjectListing(context, pair);
    expect(
      (
        await db.pool.query(
          'SELECT 1 FROM library.subject_collection_version WHERE route=$1 AND subject_id=$2 AND collection_id=$3',
          [routeOf(pair.subjectId), pair.subjectId, pair.collectionId],
        )
      ).rows,
    ).toEqual([]);
    await recoverSubjectListing(context, liveCopyLocator(listing));
    expect(
      (
        await db.pool.query(
          'SELECT 1 FROM library.subject_collection WHERE route=$1 AND subject_id=$2 AND collection_id=$3',
          [routeOf(pair.subjectId), pair.subjectId, pair.collectionId],
        )
      ).rows,
    ).toEqual([]);
    await receiving(source.creator, async (tx) => {
      expect(await openLiveCopyGate(tx, copy, proof)).toEqual(cancelled);
    });
    await recoverCreatorSale(context, liveCopyLocator(copy));
    expect(await rows(source.locator.orderId)).toEqual([]);
    expect(
      (
        await db.pool.query('SELECT state,authn_fenced FROM access.account WHERE route=$1 AND account_id=$2', [
          routeOf(people.bob.accountId),
          people.bob.accountId,
        ])
      ).rows,
    ).toEqual([{ state: 'deleted', authn_fenced: true }]);
  },
  120000,
);

test.serial(
  'a terminal receiver refuses a new role admission and recovery cancels the partial source hold',
  async () => {
    const creatorHome = partitionOf(routeOf(people.alice.accountId)!);
    const buyer = [people.staff, people.operator, people.orgOwner].find(
      (person) => person && partitionOf(routeOf(person.accountId)!) !== creatorHome,
    )!;
    expect(buyer).toBeDefined();
    const source = await seed(buyer.accountId);
    const copy = (await prepareCreatorSaleDelivery(context, source.locator, source.creator))!;
    await deletePersona({ pool: db.pool, auth }, people.alice);
    await recoverCreatorSale(context, liveCopyLocator(copy));
    expect(await readLiveCopyResult(db.pool, copy)).toMatchObject({ outcome: 'cancelled' });
    expect(await rows(source.locator.orderId)).toEqual([]);
    expect(
      (
        await db.pool.query(
          "SELECT 1 FROM access.lifecycle_coordination WHERE purpose='live-copy' AND transaction_id=$1",
          [copy.effect_key.transactionId],
        )
      ).rows,
    ).toEqual([]);
    expect(
      (
        await db.pool.query(
          "SELECT 1 FROM access.live_copy_inventory WHERE source_domain=$1 AND transition_id=$2 AND item='receiver'",
          [copy.source_domain, copy.transition_id],
        )
      ).rows,
    ).toEqual([]);
  },
  120000,
);
