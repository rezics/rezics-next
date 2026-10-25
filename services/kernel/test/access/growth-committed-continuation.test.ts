import { afterAll, beforeAll, expect, test } from 'bun:test';
import { derivedId, newId, routeOf } from '../../src/route/route.ts';
import { CONTINUATION_NAMESPACE } from '../../src/access/committed-continuations.ts';
import loadContinuation from '../../src/access/committed-continuation-load.sql';
import { withConnection } from '../../src/database/pool.ts';
import { checkGrowth, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';

let db: GrowthDatabase;
const accountId = newId(0x1234);
const route = routeOf(accountId)!;
const continuationId = derivedId(CONTINUATION_NAMESPACE, `${accountId}:fixed`, route);
const prefix = `wf:${'ab'.repeat(32)}`;

async function insertAccount(id: string) {
  await db.admin.query(
    `INSERT INTO access.account(route,account_id,kind,state,transaction_id,membership_inverse_complete)
     VALUES ($1,$2,'actor','active',$2,true)`,
    [routeOf(id), id],
  );
}
async function insertContinuation(owner: string, operationKey: string, state: 'live' | 'completed' | 'expired') {
  const ownerRoute = routeOf(owner)!;
  const id = derivedId(CONTINUATION_NAMESPACE, `${owner}:${operationKey}`, ownerRoute);
  const created = new Date(state === 'expired' ? Date.now() - 10 * 60 * 1000 : Date.now());
  const expires = new Date(created.getTime() + 300_000);
  const allowlist = [
    {
      step: 'erase-auth-owner',
      target: owner,
      key: `${prefix}:erase-auth-owner`,
      digest: 'a'.repeat(64),
    },
  ];
  const completions = state === 'completed' ? [{ ...allowlist[0], receiptId: newId(ownerRoute) }] : [];
  await db.admin.query(
    `INSERT INTO access.committed_continuation (
       route, continuation_id, account_id, operation_key, operation_digest, command_key_prefix,
       barrier_receipt_id, barrier_transaction_id, minimum_authn_epoch, allowlist, digest,
       created_at, committed_expires_at, expires_at, completions
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,1,$9::jsonb,$10,$11,$12,$12,$13::jsonb)`,
    [
      ownerRoute,
      id,
      owner,
      operationKey,
      'b'.repeat(64),
      prefix,
      newId(ownerRoute),
      newId(ownerRoute),
      JSON.stringify(allowlist),
      'c'.repeat(64),
      created.toISOString(),
      expires.toISOString(),
      JSON.stringify(completions),
    ],
  );
}

beforeAll(async () => {
  db = await openGrowthDatabase();
  await insertAccount(accountId);
  await insertContinuation(accountId, 'fixed', 'live');
});
afterAll(async () => {
  await db?.close();
});

test('continuation lookup stays bounded as unrelated accounts and continuations grow', async () => {
  const report = await checkGrowth(db, {
    name: 'committed cleanup continuation',
    repetitions: 3,
    warmups: 1,
    bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
    async grow(database, scale, previous) {
      for (let index = previous; index < scale; index += 1) {
        const owner = newId((index % 65_536) as number);
        await insertAccount(owner);
        await insertContinuation(owner, `live-${index}`, 'live');
        await insertContinuation(owner, `completed-${index}`, 'completed');
        await insertContinuation(owner, `expired-${index}`, 'expired');
      }
      await database.admin.query('VACUUM (ANALYZE) access.account');
      await database.admin.query('VACUUM (ANALYZE) access.committed_continuation');
    },
    async operation(database) {
      await withConnection(database.pool, async (client) => {
        await client.query('BEGIN');
        try {
          await client.query('SET LOCAL enable_seqscan = off');
          const row = await loadContinuation.run(client, { route, continuation_id: continuationId });
          const found = Array.isArray(row) ? row.length === 1 : row != null;
          expect(found).toBe(true);
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        }
      });
    },
  });
  expect(report.samples.map((sample) => sample.scale)).toEqual([1, 8, 64]);
});
