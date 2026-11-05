import { afterAll, beforeAll, expect, test } from 'bun:test';
import { Value } from 'typebox/value';
import { bootstrapLocalShowcaseBoardCreation } from '../../src/access/bootstrap-governance.ts';
import { createGrantCommands, GrantDeniedError } from '../../src/access/grant-commands.ts';
import { IdempotencyConflictError } from '../../src/command/command.ts';
import { COMMERCE_EVENTS } from '../../src/commerce/events.ts';
import {
  createCommerceCommands,
  OfferRevisionConflictError,
  OfferUnavailableError,
} from '../../src/commerce/commands.ts';
import { deadlineFor } from '../../src/request/deadline.ts';
import { routeOf } from '../../src/route/route.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import {
  createProfileEntryFixture,
  entryKey,
  type NativeProfileFixture,
} from '../library/support/profile-entry-fixture.ts';
import { createNativeEditionFixture } from './support/native-edition-fixture.ts';

let f: NativeProfileFixture;
let commands: ReturnType<typeof createCommerceCommands>;
let seller: Awaited<ReturnType<NativeProfileFixture['identity']>>;
let buyer: Awaited<ReturnType<NativeProfileFixture['identity']>>;
let other: Awaited<ReturnType<NativeProfileFixture['identity']>>;
let edition: Awaited<ReturnType<Awaited<ReturnType<typeof createNativeEditionFixture>>['publish']>>;

const publisherScopes = [
  'offer:create',
  'offer:manage',
  'offer:read',
  'subject:read',
  'subject:create',
  'board:create',
  'thread:create',
  'post:revise',
  'edition:sell',
];

beforeAll(async () => {
  f = await createProfileEntryFixture();
  commands = createCommerceCommands({ pool: f.pool, access: f.access });
  seller = await f.identity(publisherScopes);
  other = await f.identity(publisherScopes);
  buyer = await f.identity(['order:create', 'order:read']);
  await bootstrapLocalShowcaseBoardCreation(f.pool, f.steward.actor.accountId);
  const grants = createGrantCommands({ pool: f.pool, access: f.access, managementAction: 'access:grant' });
  for (const person of [seller, other]) {
    await grants.create(
      { pool: f.pool, actor: f.steward.actor, deadline: deadlineFor(30_000) },
      {
        resource: { route: 0, id: GLOBAL_CONTEXT },
        subject: { kind: 'account', id: person.actor.accountId },
        actions: ['offer:create', 'subject:create'],
        valid: '(,)',
        key: entryKey(),
      },
    );
    await grants.create(
      { pool: f.pool, actor: f.steward.actor, deadline: deadlineFor(30_000) },
      {
        resource: { route: 0, id: GLOBAL_CONTEXT },
        subject: { kind: 'account', id: person.actor.accountId },
        actions: ['board:create'],
        valid: '(,)',
        key: entryKey(),
      },
    );
  }
  const publisher = await createNativeEditionFixture((method, path, body, headers) =>
    f.sendWithHeaders(seller.bearer, method, path, body, headers),
  );
  edition = await publisher.publish({
    title: 'Captured revise edition',
    subjectTitle: 'Captured revise source',
    body: 'Native revise-offer edition bytes',
  });
}, 120_000);

afterAll(async () => {
  await f?.close();
});

async function offer() {
  return (
    await commands.createOffer(
      seller.actor,
      {
        contentEditionId: edition.contentEditionId,
        targetSubjectId: edition.targetSubjectId,
        title: 'Captured revise edition',
        currency: 'usd',
        unitAmountMinor: 1200,
        taxCode: 'txcd_10302000',
      },
      entryKey(),
    )
  ).value;
}

async function eventRows(transactionId: string) {
  const receipt = (
    await f.pool.query('SELECT partition_no,position FROM core.receipt WHERE transaction_id=$1', [transactionId])
  ).rows[0];
  return f.pool.query('SELECT type,data FROM core.outbox WHERE partition_no=$1 AND position=$2 ORDER BY event_seq', [
    receipt.partition_no,
    receipt.position,
  ]);
}

async function grantOrderCreate(offerId: string) {
  const grants = createGrantCommands({ pool: f.pool, access: f.access, managementAction: 'access:grant' });
  await grants.create(
    { pool: f.pool, actor: f.steward.actor, deadline: deadlineFor(30_000) },
    {
      resource: { route: routeOf(offerId)!, id: offerId },
      subject: { kind: 'account', id: buyer.actor.accountId },
      actions: ['order:create'],
      valid: '(,)',
      key: entryKey(),
    },
  );
}

test('offer owner revises active price, preserving captured orders and exact receipt replay', async () => {
  const created = await offer();
  await grantOrderCreate(created.id);
  const before = (await commands.createOrder(buyer.actor, created.id, created.revision, entryKey())).value;
  const requestKey = entryKey();
  const revised = await commands.reviseOffer(
    seller.actor,
    created.id,
    { unitAmountMinor: 2400, expectedRevision: created.revision },
    requestKey,
  );

  expect(revised.value).toMatchObject({
    id: created.id,
    unitAmountMinor: 2400,
    state: 'active',
    revision: created.revision + 1,
    contentEdition: created.contentEdition,
  });
  const after = (await commands.createOrder(buyer.actor, created.id, revised.value.revision, entryKey())).value;
  expect(before).toMatchObject({ offerRevision: created.revision, unitAmountMinor: created.unitAmountMinor });
  expect(after).toMatchObject({ offerRevision: revised.value.revision, unitAmountMinor: 2400 });
  expect(before.contentEdition).toEqual(created.contentEdition);
  expect(after.contentEdition).toEqual(created.contentEdition);

  const replay = await commands.reviseOffer(
    seller.actor,
    created.id,
    { unitAmountMinor: 2400, expectedRevision: created.revision },
    requestKey,
  );
  expect(replay).toMatchObject({
    value: revised.value,
    transactionId: revised.transactionId,
    position: revised.position,
    replayed: true,
  });
  await expect(
    commands.reviseOffer(
      seller.actor,
      created.id,
      { unitAmountMinor: 2500, expectedRevision: created.revision },
      requestKey,
    ),
  ).rejects.toBeInstanceOf(IdempotencyConflictError);

  const rows = await eventRows(revised.transactionId);
  expect(rows.rows).toEqual([{ type: 'com.rezics.commerce.offer.revised.v1', data: { offerId: created.id } }]);
  const schema = COMMERCE_EVENTS['com.rezics.commerce.offer.revised.v1'];
  expect(Value.Check(schema, { offerId: created.id })).toBe(true);
  expect(Value.Check(schema, { offerId: created.id, state: 'active' })).toBe(false);
});

test('stale expectedRevision refuses before mutation, and non-owners and delisted offers cannot revise', async () => {
  const created = await offer();
  const before = await f.pool.query(
    'SELECT revision, unit_amount_minor, updated_at, transaction_id FROM commerce.offer WHERE route=$1 AND offer_id=$2',
    [routeOf(created.id)!, created.id],
  );
  const counts = await f.pool.query('SELECT count(*)::int AS count FROM core.outbox');
  await expect(
    commands.reviseOffer(
      seller.actor,
      created.id,
      { unitAmountMinor: 2400, expectedRevision: created.revision + 1 },
      entryKey(),
    ),
  ).rejects.toBeInstanceOf(OfferRevisionConflictError);
  expect(
    (
      await f.pool.query(
        'SELECT revision, unit_amount_minor, updated_at, transaction_id FROM commerce.offer WHERE route=$1 AND offer_id=$2',
        [routeOf(created.id)!, created.id],
      )
    ).rows,
  ).toEqual(before.rows);
  expect((await f.pool.query('SELECT count(*)::int AS count FROM core.outbox')).rows).toEqual(counts.rows);

  await expect(
    commands.reviseOffer(
      other.actor,
      created.id,
      { unitAmountMinor: 2400, expectedRevision: created.revision },
      entryKey(),
    ),
  ).rejects.toBeInstanceOf(GrantDeniedError);
  expect(
    (
      await f.pool.query(
        'SELECT revision, unit_amount_minor, updated_at, transaction_id FROM commerce.offer WHERE route=$1 AND offer_id=$2',
        [routeOf(created.id)!, created.id],
      )
    ).rows,
  ).toEqual(before.rows);

  await commands.delistOffer(seller.actor, created.id, entryKey(), created.revision);
  const delisted = await f.pool.query(
    'SELECT revision, unit_amount_minor, updated_at, transaction_id FROM commerce.offer WHERE route=$1 AND offer_id=$2',
    [routeOf(created.id)!, created.id],
  );
  const outbox = await f.pool.query('SELECT count(*)::int AS count FROM core.outbox');
  await expect(
    commands.reviseOffer(
      seller.actor,
      created.id,
      { unitAmountMinor: 2400, expectedRevision: created.revision },
      entryKey(),
    ),
  ).rejects.toBeInstanceOf(OfferUnavailableError);
  expect(
    (
      await f.pool.query(
        'SELECT revision, unit_amount_minor, updated_at, transaction_id FROM commerce.offer WHERE route=$1 AND offer_id=$2',
        [routeOf(created.id)!, created.id],
      )
    ).rows,
  ).toEqual(delisted.rows);
  expect((await f.pool.query('SELECT count(*)::int AS count FROM core.outbox')).rows).toEqual(outbox.rows);
});

test('same price is a new revision with exactly one revised event', async () => {
  const created = await offer();
  const revised = await commands.reviseOffer(
    seller.actor,
    created.id,
    { unitAmountMinor: created.unitAmountMinor, expectedRevision: created.revision },
    entryKey(),
  );
  expect(revised.value.revision).toBe(created.revision + 1);
  expect(revised.value.unitAmountMinor).toBe(created.unitAmountMinor);
  expect(revised.value.contentEdition).toEqual(created.contentEdition);
  const stored = (
    await f.pool.query('SELECT updated_at, transaction_id FROM commerce.offer WHERE route=$1 AND offer_id=$2', [
      routeOf(created.id)!,
      created.id,
    ])
  ).rows[0];
  expect(stored.updated_at).toBeInstanceOf(Date);
  expect(stored.transaction_id).toBe(revised.transactionId);
  expect((await eventRows(revised.transactionId)).rows).toEqual([
    { type: 'com.rezics.commerce.offer.revised.v1', data: { offerId: created.id } },
  ]);
});
