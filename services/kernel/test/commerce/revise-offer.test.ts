import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { Value } from 'typebox/value';
import { createAccess } from '../../src/access/index.ts';
import { GrantDeniedError } from '../../src/access/grant-commands.ts';
import { IdempotencyConflictError } from '../../src/command/command.ts';
import { createPool } from '../../src/database/pool.ts';
import { type Actor } from '../../src/request/access.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { COMMERCE_EVENTS } from '../../src/commerce/events.ts';
import { createCommerceCommands, OfferUnavailableError } from '../../src/commerce/commands.ts';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(url);
pool.options.max = 1;
const operator = newId(0x1100);
const seller = newId(0x2200);
const buyer = newId(0x3300);
const other = newId(0x4400);
const actions = ['access:grant', 'offer:create', 'offer:read', 'offer:manage', 'order:create'];
let access: ReturnType<typeof createAccess>;
let commands: ReturnType<typeof createCommerceCommands>;
let signing: Awaited<ReturnType<typeof generateKeyPair>>;
const key = () => Bun.randomUUIDv7();
const input = () => ({
  targetSubjectId: newId(0x5500),
  title: 'Book',
  currency: 'usd',
  unitAmountMinor: 1200,
  taxCode: 'txcd_10302000',
});

async function actor(id: string): Promise<Actor> {
  const token = await new SignJWT({
    client_id: 'web',
    scope: actions.join(' '),
    authn_epoch: 1,
    auth_time: Math.floor(Date.now() / 1000),
    amr: ['pwd'],
  })
    .setProtectedHeader({ alg: 'ES256', kid: 'commerce', typ: 'at+jwt' })
    .setIssuer('https://auth.example.test')
    .setAudience('https://api.rezics.test')
    .setSubject(id)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(signing.privateKey);
  return access.authenticate(token, { pool, deadline: Date.now() + 5000 });
}

beforeAll(async () => {
  signing = await generateKeyPair('ES256', { extractable: true });
  const jwk = { ...(await exportJWK(signing.publicKey)), kid: 'commerce', alg: 'ES256' };
  access = createAccess({
    actions: new Map(
      actions.map((action) => [
        action,
        {
          anonymous: false,
          ...(action === 'offer:create' ? { 'x-resource-types': ['commerce.offer'] } : {}),
        },
      ]),
    ),
    auth: {
      issuer: 'https://auth.example.test',
      audience: 'https://api.rezics.test',
      jwksUrl: 'https://auth.example.test/jwks',
      fetch: async () => Response.json({ keys: [jwk] }),
    },
  });
  commands = createCommerceCommands({ pool, access });
  for (const id of [operator, seller, buyer, other])
    await pool.query(
      "INSERT INTO access.account(route,account_id,kind,state,transaction_id) VALUES ($1,$2,'actor','active',$2)",
      [routeOf(id), id],
    );
});

beforeEach(async () => {
  await pool.query(
    'TRUNCATE commerce.order_transaction, commerce.entitlement, commerce.purchase_order, commerce.offer, access.resource_role_grant, access.resource_initialization, access.resource_grant, access.resource_denial, core.receipt, core.outbox',
  );
  await pool.query("UPDATE access.account SET state='active'");
  await pool.query(
    "INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id) VALUES (0,$1,$2,'access:grant','(,)',$2),(0,$1,$2,'offer:create','(,)',$2)",
    [GLOBAL_CONTEXT, operator],
  );
  await pool.query(
    "INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id) VALUES (0,$1,$2,'offer:create','(,)',$2)",
    [GLOBAL_CONTEXT, seller],
  );
});

afterAll(() => pool.end());

async function offer() {
  return (await commands.createOffer(await actor(seller), input(), key())).value;
}

async function eventRows(transactionId: string) {
  const receipt = (
    await pool.query('SELECT partition_no,position FROM core.receipt WHERE transaction_id=$1', [transactionId])
  ).rows[0];
  return pool.query('SELECT type,data FROM core.outbox WHERE partition_no=$1 AND position=$2 ORDER BY event_seq', [
    receipt.partition_no,
    receipt.position,
  ]);
}

test('offer owner revises active price, preserving order snapshots and idempotent receipts', async () => {
  const created = await offer();
  const before = (await commands.createOrder(await actor(buyer), created.id, created.revision, key())).value;
  const requestKey = key();
  const revised = await commands.reviseOffer(await actor(seller), created.id, { unitAmountMinor: 2400 }, requestKey);

  expect(revised.value).toMatchObject({
    id: created.id,
    unitAmountMinor: 2400,
    state: 'active',
    revision: created.revision + 1,
  });
  const after = (await commands.createOrder(await actor(buyer), created.id, revised.value.revision, key())).value;
  expect(before).toMatchObject({ offerRevision: created.revision, unitAmountMinor: created.unitAmountMinor });
  expect(after).toMatchObject({ offerRevision: revised.value.revision, unitAmountMinor: 2400 });

  const replay = await commands.reviseOffer(await actor(seller), created.id, { unitAmountMinor: 2400 }, requestKey);
  expect(replay).toMatchObject({
    value: revised.value,
    transactionId: revised.transactionId,
    position: revised.position,
    replayed: true,
  });
  await expect(
    commands.reviseOffer(await actor(seller), created.id, { unitAmountMinor: 2500 }, requestKey),
  ).rejects.toBeInstanceOf(IdempotencyConflictError);

  const rows = await eventRows(revised.transactionId);
  expect(rows.rows).toEqual([{ type: 'com.rezics.commerce.offer.revised.v1', data: { offerId: created.id } }]);
  const schema = COMMERCE_EVENTS['com.rezics.commerce.offer.revised.v1'];
  expect(Value.Check(schema, { offerId: created.id })).toBe(true);
  expect(Value.Check(schema, { offerId: created.id, state: 'active' })).toBe(false);
});

test('non-owner and delisted offers cannot be revised', async () => {
  const created = await offer();
  const before = await pool.query(
    'SELECT revision, unit_amount_minor, updated_at, transaction_id FROM commerce.offer WHERE route=$1 AND offer_id=$2',
    [routeOf(created.id)!, created.id],
  );
  const counts = await pool.query('SELECT count(*)::int AS count FROM core.outbox');
  await expect(
    commands.reviseOffer(await actor(other), created.id, { unitAmountMinor: 2400 }, key()),
  ).rejects.toBeInstanceOf(GrantDeniedError);
  expect(
    (
      await pool.query(
        'SELECT revision, unit_amount_minor, updated_at, transaction_id FROM commerce.offer WHERE route=$1 AND offer_id=$2',
        [routeOf(created.id)!, created.id],
      )
    ).rows,
  ).toEqual(before.rows);
  expect((await pool.query('SELECT count(*)::int AS count FROM core.outbox')).rows).toEqual(counts.rows);

  await commands.delistOffer(await actor(seller), created.id, key());
  const delisted = await pool.query(
    'SELECT revision, unit_amount_minor, updated_at, transaction_id FROM commerce.offer WHERE route=$1 AND offer_id=$2',
    [routeOf(created.id)!, created.id],
  );
  const outbox = await pool.query('SELECT count(*)::int AS count FROM core.outbox');
  await expect(
    commands.reviseOffer(await actor(seller), created.id, { unitAmountMinor: 2400 }, key()),
  ).rejects.toBeInstanceOf(OfferUnavailableError);
  expect(
    (
      await pool.query(
        'SELECT revision, unit_amount_minor, updated_at, transaction_id FROM commerce.offer WHERE route=$1 AND offer_id=$2',
        [routeOf(created.id)!, created.id],
      )
    ).rows,
  ).toEqual(delisted.rows);
  expect((await pool.query('SELECT count(*)::int AS count FROM core.outbox')).rows).toEqual(outbox.rows);
});

test('same price is a new revision with exactly one revised event', async () => {
  const created = await offer();
  const revised = await commands.reviseOffer(
    await actor(seller),
    created.id,
    { unitAmountMinor: created.unitAmountMinor },
    key(),
  );
  expect(revised.value.revision).toBe(created.revision + 1);
  expect(revised.value.unitAmountMinor).toBe(created.unitAmountMinor);
  const stored = (
    await pool.query('SELECT updated_at, transaction_id FROM commerce.offer WHERE route=$1 AND offer_id=$2', [
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
