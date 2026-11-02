import { afterAll, beforeAll, expect, test } from 'bun:test';
import { noEffect, runCommand, type CommandTransaction } from '../../src/command/command.ts';
import { newId, partitionOf, PARTITIONS } from '../../src/route/route.ts';
import { HistoryRegistry, type HistoryBarrier, type HistoryFamilySource } from '../../src/history/registry.ts';
import { advanceHistoryFamilyCoverage, installHistoryFamilyDefinitions } from '../../src/history/family-coverage.ts';
import {
  readHistoryOwnerCoverage,
  verifyHistoryOwnerCoverage,
  recordHistoryReceivingProof,
  type HistoryOwnerCoverage,
} from '../../src/history/receiving.ts';
import { minimizeHistoryReceipt } from '../../src/history/receipt.ts';
import { decodeLocator } from '../../src/history/locator.ts';
import { custodyFixture, scope, type CustodyFixture } from './command-custody-fixture.ts';

let f: CustodyFixture;
const route = 0x6a30;
const sources: readonly HistoryFamilySource[] = [
  { artifactType: 'command-receipt/v1', producer: 'access.account.preferences', version: 1 },
  { artifactType: 'command-receipt/v1', producer: 'access.account.preferences.former', version: 1 },
];
let registry: HistoryRegistry;
beforeAll(async () => {
  f = await custodyFixture();
  registry = new HistoryRegistry();
  registry.registerCoverage('access', ['command-receipt/v1', 'outbox-event/v1', 'durable-work/v1']);
  registry.registerFamilySources('access', 1, sources);
  registry.registerOwner({
    name: 'access.account.preferences',
    artifactType: 'command-receipt/v1',
    version: 1,
    async readiness() {
      return { ready: true };
    },
  });
  registry.seal();
  await f.db.admin.query(
    `INSERT INTO core.history_registry(singleton,digest,gaps) VALUES(true,$1,$2)
     ON CONFLICT(singleton) DO UPDATE SET digest=EXCLUDED.digest,gaps=EXCLUDED.gaps`,
    [registry.digest(), JSON.stringify(registry.gaps())],
  );
  await installHistoryFamilyDefinitions(f.db.admin, registry);
}, 180_000);
afterAll(async () => {
  await f?.close();
});

async function account() {
  const accountId = newId(route);
  await f.db.admin.query(
    `INSERT INTO access.account(route,account_id,kind,state,transaction_id) VALUES($1,$2,'actor','active',$2)`,
    [route, accountId],
  );
  return accountId;
}
async function erase(accountId: string): Promise<HistoryBarrier> {
  await f.db.admin.query("UPDATE access.account SET state='deleted' WHERE route=$1 AND account_id=$2", [
    route,
    accountId,
  ]);
  const row = (
    await f.db.admin.query<{ version: number; at: string }>(
      `INSERT INTO access.erasure(route,account_id,version,at) VALUES($1,$2,1,now()) RETURNING version,at::text`,
      [route, accountId],
    )
  ).rows[0]!;
  return { accountId, accountRoute: route, ...row };
}
/** The existing fixture's complete native producer catalogue has these two versions. Its owner
 * enrolls the actual native high-water cut, including all empty sealed homes. This is fixture
 * source enrollment; production owners must supply their own historical source inventory. */
async function enroll(barrier: HistoryBarrier, former = true) {
  await f.db.admin.query(
    `INSERT INTO core.history_seal(partition_no,account_route,account_id,barrier_id,phase)
     SELECT partition_no,$1,$2,$2,'sealed' FROM core.partition
     ON CONFLICT(partition_no,account_route,account_id) DO UPDATE SET barrier_id=$2,phase='sealed'`,
    [route, barrier.accountId],
  );
  await f.db.admin.query(
    `INSERT INTO core.history_family_enrollment(family,account_route,account_id,partition_no,artifact_type,producer,
      producer_version,definition_digest,barrier_version,barrier_at,partition_epoch,source_cut)
     SELECT d.family,e.route,e.account_id,p.partition_no,s."artifactType",s.producer,s.version,d.digest,e.version,e.at::text,
       p.epoch,int8send(p.position)
     FROM core.history_family_definition d,core.partition p,access.erasure e,
       LATERAL jsonb_to_recordset(d.sources) AS s("artifactType" text,producer text,version integer)
     WHERE d.family='access' AND e.route=$1 AND e.account_id=$2 AND ($3 OR s.producer NOT LIKE '%.former')
     ON CONFLICT DO NOTHING`,
    [route, barrier.accountId, former],
  );
}
async function drive(barrier: HistoryBarrier) {
  for (let unit = 0; unit < PARTITIONS * 2 + 4; unit++) {
    const answer = await advanceHistoryFamilyCoverage({ pool: f.db.pool }, barrier, 'access');
    if (answer.state !== 'more') return answer;
  }
  throw new Error('Native family progress exceeded its finite fixture frontier');
}
const read = (barrier: HistoryBarrier) =>
  readHistoryOwnerCoverage({ pool: f.db.pool }, barrier, 'access', { deadline: Date.now() + 30_000 });
async function complete(barrier: HistoryBarrier): Promise<HistoryOwnerCoverage> {
  expect(await drive(barrier)).toEqual({ state: 'complete' });
  const result = await read(barrier);
  expect(result.state).toBe('complete');
  if (result.state !== 'complete') throw new Error('Native coverage issuer unavailable');
  return result.coverage;
}
async function final<T>(
  barrier: HistoryBarrier,
  body: (tx: CommandTransaction) => Promise<T>,
  partition = partitionOf(route),
) {
  return runCommand(
    f.db.pool,
    {
      principal: { kind: 'account', id: barrier.accountId },
      basis: { clientId: null, requestedBy: null },
      partition,
      deadline: Date.now() + 30_000,
    },
    async (tx) => noEffect(await body(tx)),
  );
}
async function noAck(barrier: HistoryBarrier) {
  expect(
    (
      await f.db.admin.query('SELECT 1 FROM access.erasure_acknowledgement WHERE route=$1 AND account_id=$2', [
        route,
        barrier.accountId,
      ])
    ).rows,
  ).toHaveLength(0);
}

test('native sealed complete family history coverage issues exact opaque root-bound proof with account-home current verification and routing invalidation, while missing historical producer or receiving custody remains pending without a final ACK cycle', async () => {
  const barrier = await erase(await account());
  await enroll(barrier);
  const proof = await complete(barrier);
  expect(Object.keys(proof)).toEqual([]);
  expect((await final(barrier, (tx) => verifyHistoryOwnerCoverage(tx, barrier, 'access', proof))).value).toBe(true);
  expect((await final(barrier, (tx) => verifyHistoryOwnerCoverage(tx, barrier, 'access', { ...proof }))).value).toBe(
    false,
  );
  expect((await final(barrier, (tx) => verifyHistoryOwnerCoverage(tx, barrier, 'zones', proof))).value).toBe(false);
  expect(
    (await final(barrier, (tx) => verifyHistoryOwnerCoverage(tx, { ...barrier, version: 2 }, 'access', proof))).value,
  ).toBe(false);
  expect(
    (await final(barrier, (tx) => verifyHistoryOwnerCoverage(tx, barrier, 'access', proof), partitionOf(route) + 1))
      .value,
  ).toBe(false);
  const foreign = await readHistoryOwnerCoverage({ pool: f.db.pool }, barrier, 'semantic', {
    deadline: Date.now() + 30_000,
  });
  expect(foreign.state).toBe('pending');
  await f.db.admin.query('UPDATE core.partition SET epoch=epoch+1 WHERE partition_no=1970');
  expect((await final(barrier, (tx) => verifyHistoryOwnerCoverage(tx, barrier, 'access', proof))).value).toBe(false);
  expect((await read(barrier)).state).toBe('pending');
  await noAck(barrier);
}, 180_000);

test('a missing former native producer stays an exact gap even on an empty sealed prefix', async () => {
  const barrier = await erase(await account());
  await enroll(barrier, false);
  expect(await drive(barrier)).toEqual({
    state: 'pending',
    gap: 'access:command-receipt/v1:access.account.preferences.former:historical-enrollment',
  });
  expect(await read(barrier)).toEqual({
    state: 'pending',
    gaps: ['access:command-receipt/v1:access.account.preferences.former:historical-enrollment'],
  });
  await noAck(barrier);
}, 180_000);

test('historical copied native role union requires actual receiving custody and rejects physical source loss', async () => {
  const accountId = await account();
  const producer = await f.auth.person('family-history-producer');
  await f.command(producer, 'historical-family-copy', scope({ accountId }), undefined, 0);
  const barrier = await erase(accountId);
  await enroll(barrier);
  expect(await drive(barrier)).toEqual({ state: 'pending', gap: 'access:command-receipt/v1:receiving-custody' });
  const row = (
    await f.db.admin.query<{ locator: Buffer }>(
      `SELECT locator FROM core.history_locator WHERE partition_no=0 AND account_route=$1 AND account_id=$2
     AND artifact_type='command-receipt/v1'`,
      [route, accountId],
    )
  ).rows[0]!;
  const locator = decodeLocator('command-receipt/v1', row.locator);
  const client = await f.db.admin.connect();
  try {
    await client.query('BEGIN');
    expect(
      await minimizeHistoryReceipt(
        client,
        { partition_no: 0, account_route: route, account_id: accountId },
        row.locator,
        registry,
        barrier,
      ),
    ).toBeNull();
    expect(await recordHistoryReceivingProof(client, barrier, 0, locator)).toBeNull();
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  const proof = await complete(barrier);
  const union = (
    await f.db.admin.query(
      `SELECT account_id,roles FROM core.history_locator WHERE partition_no=0 AND artifact_type='command-receipt/v1'
     AND locator=$1 ORDER BY account_id`,
      [row.locator],
    )
  ).rows;
  expect(union.some((ref) => ref.account_id === accountId && ref.roles === 32)).toBe(true);
  expect(union.some((ref) => ref.account_id === producer.accountId && ref.roles > 0)).toBe(true);
  expect((await final(barrier, (tx) => verifyHistoryOwnerCoverage(tx, barrier, 'access', proof))).value).toBe(true);
  const receivingAccount = await account();
  await expect(
    final(barrier, async (tx) => {
      await tx.query(
        `INSERT INTO core.history_locator(partition_no,account_route,account_id,artifact_type,locator,roles,minimizer_version)
       VALUES(0,$1,$2,'command-receipt/v1',$3,32,1)`,
        [route, receivingAccount, row.locator],
      );
      expect(await verifyHistoryOwnerCoverage(tx, barrier, 'access', proof)).toBe(false);
      throw new Error('receiving-role-rollback');
    }),
  ).rejects.toThrow('receiving-role-rollback');
  expect((await final(barrier, (tx) => verifyHistoryOwnerCoverage(tx, barrier, 'access', proof))).value).toBe(true);
  await f.db.admin.query(
    `DELETE FROM core.receipt WHERE partition_no=0 AND principal_id=$1 AND command_kind='access.account.preferences'`,
    [producer.accountId],
  );
  expect((await final(barrier, (tx) => verifyHistoryOwnerCoverage(tx, barrier, 'access', proof))).value).toBe(false);
  expect(await drive(barrier)).toEqual({ state: 'pending', gap: 'access:command-receipt/v1:receiving-custody' });
  await noAck(barrier);
}, 180_000);

test('final verification and native invalidation roll back atomically', async () => {
  const barrier = await erase(await account());
  await enroll(barrier);
  const proof = await complete(barrier);
  const before = (
    await f.db.admin.query('SELECT revision FROM core.history_family_fence WHERE account_route=$1 AND account_id=$2', [
      route,
      barrier.accountId,
    ])
  ).rows[0]!.revision;
  await expect(
    final(barrier, async (tx) => {
      expect(await verifyHistoryOwnerCoverage(tx, barrier, 'access', proof)).toBe(true);
      await tx.query(
        `UPDATE core.history_family_enrollment SET source_cut=source_cut||decode('01','hex')
       WHERE account_route=$1 AND account_id=$2 AND partition_no=0`,
        [route, barrier.accountId],
      );
      expect(await verifyHistoryOwnerCoverage(tx, barrier, 'access', proof)).toBe(false);
      throw new Error('native-final-rollback');
    }),
  ).rejects.toThrow('native-final-rollback');
  expect(
    (
      await f.db.admin.query(
        'SELECT revision FROM core.history_family_fence WHERE account_route=$1 AND account_id=$2',
        [route, barrier.accountId],
      )
    ).rows[0]!.revision,
  ).toBe(before);
  expect((await final(barrier, (tx) => verifyHistoryOwnerCoverage(tx, barrier, 'access', proof))).value).toBe(true);
  await noAck(barrier);
}, 180_000);
