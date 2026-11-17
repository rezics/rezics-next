import { afterAll, expect, test } from 'bun:test';
import { createPool } from '../../src/database/pool.ts';
import { confirmRealmMemberSelection, selectRealmMembers } from '../../src/community/member-page.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';

const pool = createPool(process.env.DATABASE_URL!);
afterAll(() => pool.end());

test('committed publication transactions are opaque UUIDs while exact receipt and terminal proof stay required', async () => {
  // The command executor generates UUIDv7 transaction IDs without embedding a resource route.
  const transactionId = Bun.randomUUIDv7();
  const route = (routeOf(transactionId)! + 1) % 65_536;
  const accountRoute = (route + 1) % 65_536;
  const realmId = newId(route);
  const accountId = newId(accountRoute);
  const viewerAccountId = newId(route);
  const reservationId = newId(accountRoute);
  const generationId = newId(accountRoute);
  const commandKey = crypto.randomUUID();
  const at = new Date().toISOString();
  const transition = { generationId, operationId: commandKey, outcome: 'published' };
  const response = { realmId, accountId, reservationId, publicationTransactionId: transactionId, transition };
  await pool.query(
    `INSERT INTO community.realm_member (route,realm_id,account_id,role,valid,reservation_id,transaction_id)
     VALUES ($1,$2,$3,'member',tstzrange($4,NULL,'[)'),$5,$6)`,
    [route, realmId, accountId, at, reservationId, transactionId],
  );
  await pool.query(
    `INSERT INTO community.realm_membership_proof
       (route,realm_id,account_id,reservation_id,generation_id,operation_id,outcome,transaction_id,
        publication_transaction_id,principal_id,command_kind,command_key,at)
     VALUES ($1,$2,$3,$4,$5,$6,'published',$7,$7,$8,'community.realm.membership',$6,$9)`,
    [route, realmId, accountId, reservationId, generationId, commandKey, transactionId, viewerAccountId, at],
  );
  await pool.query(
    `INSERT INTO core.receipt
       (partition_no,principal_kind,principal_id,command_kind,idempotency_key,request_digest,epoch,position,
        transaction_id,response)
     VALUES ($1,'account',$2,'community.realm.membership',$3,$4,1,1,$5,$6)`,
    [partitionOf(route), viewerAccountId, commandKey, Buffer.alloc(32), transactionId, JSON.stringify(response)],
  );
  const read = () =>
    selectRealmMembers(
      { pool, tokens: { current: 1, keys: new Map([[1, new Uint8Array(32).fill(7)]]) }, deadline: Date.now() + 2_000 },
      { realmId, viewerAccountId, selectedAccountId: accountId, at },
    );
  const selected = await read();
  expect(selected).toMatchObject({ state: 'ready', selected: { accountId, membership: 'member' } });
  if (selected.state !== 'ready') throw new Error('Expected the committed native membership');
  expect(selected.members).toEqual([{ accountId, reservationId, transactionId }]);
  expect(
    await confirmRealmMemberSelection(
      { pool, deadline: Date.now() + 2_000 },
      { realmId, at, members: selected.members, selected: selected.selected },
    ),
  ).toBe(true);
  await pool.query('UPDATE core.receipt SET response=$1 WHERE transaction_id=$2', [
    JSON.stringify({ ...response, publicationTransactionId: Bun.randomUUIDv7() }),
    transactionId,
  ]);
  expect(await read()).toMatchObject({ state: 'preparing', selected: null });
  await pool.query('UPDATE core.receipt SET response=$1 WHERE transaction_id=$2', [
    JSON.stringify(response),
    transactionId,
  ]);
  await pool.query(
    `INSERT INTO community.realm_member_terminal (route,realm_id,account_id,reservation_id,transaction_id,at)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [route, realmId, accountId, reservationId, Bun.randomUUIDv7(), at],
  );
  expect(await read()).toMatchObject({ state: 'preparing', selected: null });
});
