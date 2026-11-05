import { afterAll, expect, test } from 'bun:test';
import { createHmac, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRatingCounter } from '../../src/access/index.ts';
import { readAccount, readPublicAccount, readPublicIdentities } from '../../src/access/account-data.ts';
import { createLifecycleCommands, LIFECYCLE_ACTIONS } from '../../src/access/lifecycle.ts';
import { installAccessClock } from '../../src/access/access-clock.ts';
import { createOperatorCommands } from '../../src/access/operator.ts';
import { createAccess } from '../../src/access/permission.ts';
import { createPool } from '../../src/database/pool.ts';
import { newId, routeOf } from '../../src/route/route.ts';

const pool = createPool(process.env.DATABASE_URL!);
const secret = randomBytes(32);
const ratingCounter = createRatingCounter({ secret });
const actions = new Map([...LIFECYCLE_ACTIONS, ['account:manage', { anonymous: false }]]);
const access = createAccess({ actions, accountEvidence: (_actor, context) => context.account });
let now = new Date('2026-10-01T12:00:00.000Z');
installAccessClock(access, () => now);
const operators = createOperatorCommands({ pool, access, actions, managementAction: 'account:manage' });
const eventType = 'com.rezics.access.rating-counter.changed.v1';
const key = () => Bun.randomUUIDv7();
afterAll(() => pool.end());

async function account(operatorId: string | null = null, kind = 'actor') {
  const id = newId(0x4567);
  await pool.query(
    `INSERT INTO access.account(route,account_id,kind,state,operator_account_id,transaction_id)
     VALUES ($1,$2,$3,'active',$4,$2)`,
    [routeOf(id), id, kind, operatorId],
  );
  return id;
}
async function relation(subjectId: string, operatorId: string, previous: string | null, version: string) {
  const reservation = await operators.reserveResponsibility({
    operatorAccountId: operatorId,
    subjectAccountId: subjectId,
    key: key(),
  });
  return {
    subjectAccountId: subjectId,
    operatorAccountId: operatorId,
    reservationId: reservation.value.reservationId,
    expectedOperatorAccountId: previous,
    expectedVersion: version,
    key: key(),
  };
}
async function events(subjectId: string) {
  return (
    await pool.query('SELECT * FROM core.outbox WHERE subject=$1 AND type=$2 ORDER BY position', [subjectId, eventType])
  ).rows;
}

test('counting keys reveal only shared controllers and require a composition secret', async () => {
  const operator = await account();
  const automated = await account(operator);
  const sibling = await account(operator);
  const unrelated = await account();
  const organization = await account(null, 'organization');
  const count = await ratingCounter(pool, automated, now);
  expect(count).toBe(await ratingCounter(pool, operator, now));
  expect(count).toBe(await ratingCounter(pool, sibling, now));
  expect(count).not.toBe(await ratingCounter(pool, unrelated, now));
  expect(count).not.toBe(await ratingCounter(pool, organization, now));
  expect(count).toMatch(/^[0-9a-f]{64}$/);
  expect(count).not.toBe(operator);
  expect(count).not.toBe(automated);
  expect(count).toBe(createHmac('sha256', secret).update(`access.rating-counter.v1\0${operator}`).digest('hex'));
  expect(count).not.toBe(await createRatingCounter({ secret: randomBytes(32) })(pool, automated, now));
  expect(() => createRatingCounter({ secret: new Uint8Array() })).toThrow();
  await expect(ratingCounter(pool, newId(0x4567), now)).rejects.toThrow('unavailable');

  const projection = await readPublicAccount(pool, routeOf(automated)!, automated);
  const identities = await readPublicIdentities(pool, [routeOf(automated)!], [automated]);
  expect(JSON.stringify([projection, identities])).not.toContain(count);
  // The port is composed only for internal consumers; public routes cannot call it.
  for (const path of ['routes.ts', 'account-routes.ts']) {
    const file = new URL(`../../src/access/${path}`, import.meta.url);
    if (await Bun.file(file).exists()) expect(readFileSync(file, 'utf8')).not.toContain('ratingCounter');
  }
});

test('transfer publishes one atomic counter change at T and preserves earlier keys on replay', async () => {
  const source = await account();
  const destination = await account();
  const subject = await account();
  now = new Date('2026-10-02T12:00:00.000Z');
  const initial = await operators.recordOperatorRelation(await relation(subject, source, null, '0'));
  const oldKey = await ratingCounter(pool, subject, now);
  now = new Date('2026-10-03T12:00:00.000Z');
  const transfer = await relation(subject, destination, source, initial.value.version);
  const committed = await operators.recordOperatorRelation(transfer);
  expect(await ratingCounter(pool, subject, '2026-10-03 11:59:59.999999+00')).toBe(oldKey);
  expect(await ratingCounter(pool, subject, now)).toBe(await ratingCounter(pool, destination, now));
  expect(await ratingCounter(pool, subject, now)).not.toBe(oldKey);
  expect(await ratingCounter(pool, subject, '2026-10-02 12:00:00+00')).toBe(oldKey);
  const changes = await events(subject);
  const change = changes.find((event) => BigInt(event.position) === committed.position)!;
  expect(change.data).toEqual({ accountId: subject, at: '2026-10-03 12:00:00+00' });
  expect(changes).toHaveLength(2); // Initial automation and this transfer each change the controller.
  expect(
    (
      await pool.query('SELECT transaction_id FROM access.account WHERE route=$1 AND account_id=$2', [
        routeOf(subject),
        subject,
      ])
    ).rows[0].transaction_id,
  ).toBe(committed.transactionId);
  const envelope = (
    await pool.query('SELECT type FROM core.outbox WHERE partition_no=$1 AND position=$2', [
      committed.partition,
      String(committed.position),
    ])
  ).rows;
  expect(envelope.map(({ type }) => type).sort()).toEqual(
    [eventType, 'com.rezics.access.operator.relation-recorded.v1'].sort(),
  );
  expect((await operators.recordOperatorRelation(transfer)).replayed).toBe(true);
  expect(await events(subject)).toHaveLength(2);
  await expect(operators.recordOperatorRelation({ ...transfer, key: key() })).rejects.toThrow();
  expect(await events(subject)).toHaveLength(2);
});

test('a removed operator relation falls back to the account while historical reads retain it', async () => {
  const operator = await account();
  const subject = await account(operator);
  const ownKey = await ratingCounter(pool, subject, now);
  const removed = await pool.query(
    `UPDATE access.account SET operator_account_id=NULL WHERE route=$1 AND account_id=$2
     RETURNING transaction_timestamp()::text AS at`,
    [routeOf(subject), subject],
  );
  expect(await ratingCounter(pool, subject, removed.rows[0].at)).not.toBe(ownKey);
  expect(await ratingCounter(pool, subject, removed.rows[0].at)).not.toBe(
    await ratingCounter(pool, operator, removed.rows[0].at),
  );
  expect(await ratingCounter(pool, subject, now)).toBe(ownKey);
});

test('outbox failure rolls back both the relation and its counting key', async () => {
  const source = await account();
  const destination = await account();
  const subject = await account(source);
  const transfer = await relation(subject, destination, source, '0');
  await pool.query(`CREATE FUNCTION access.reject_test_counter_event() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.type = 'com.rezics.access.rating-counter.changed.v1' THEN
      RAISE EXCEPTION 'Injected counter outbox failure'; END IF; RETURN NEW; END; $$`);
  await pool.query(
    'CREATE TRIGGER reject_test_counter_event BEFORE INSERT ON core.outbox FOR EACH ROW EXECUTE FUNCTION access.reject_test_counter_event()',
  );
  try {
    await expect(operators.recordOperatorRelation(transfer)).rejects.toThrow();
    expect(await ratingCounter(pool, subject, now)).toBe(await ratingCounter(pool, source, now));
    expect(await events(subject)).toHaveLength(0);
    expect(
      (
        await pool.query('SELECT operator_account_id FROM access.account WHERE route=$1 AND account_id=$2', [
          routeOf(subject),
          subject,
        ])
      ).rows[0].operator_account_id,
    ).toBe(source);
  } finally {
    await pool.query('DROP TRIGGER reject_test_counter_event ON core.outbox');
    await pool.query('DROP FUNCTION access.reject_test_counter_event()');
  }
  await operators.recordOperatorRelation(transfer);
  expect(await ratingCounter(pool, subject, now)).toBe(await ratingCounter(pool, destination, now));
  expect(await events(subject)).toHaveLength(1);
});

test('native account deletion removes its operator relation at the deletion command T', async () => {
  const operator = await account();
  const subject = await account(operator);
  await operators.provisionManagementDefaults({ operatorAccountId: operator, key: key() });
  const lifecycle = createLifecycleCommands({ pool, access });
  now = new Date('2026-10-04T12:00:00.000Z');
  const before = await ratingCounter(pool, subject, now);
  await lifecycle.tombstone(
    {
      actor: {
        kind: 'account',
        accountId: operator,
        clientId: 'rating-test',
        scopes: [...actions.keys()],
        requestedBy: null,
        authnEpoch: 1,
      },
      account: await readAccount(pool, routeOf(operator)!, operator),
      deadline: Date.now() + 3000,
    },
    { accountId: subject, key: key() },
  );
  expect(await ratingCounter(pool, subject, '2026-10-04 11:59:59.999999+00')).toBe(before);
  expect(await ratingCounter(pool, subject, now)).not.toBe(before);
  expect(await ratingCounter(pool, subject, now)).toBe(
    createHmac('sha256', secret).update(`access.rating-counter.v1\0${subject}`).digest('hex'),
  );
});
