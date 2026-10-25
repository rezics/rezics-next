import { afterAll, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { createPool } from '../src/database/pool.ts';
import { ANONYMOUS_PRINCIPAL_ID, principalCommandIdentity, runCommand } from '../src/command/command.ts';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL must name the migrated test database');
const admin = createPool(url);
afterAll(() => admin.end());
const account = '019a1b2c-3d4e-7f00-8a00-beef00000001';
const event = { type: 'com.rezics.test.migration.v1', data: {} };
const digest = createHash('sha256').update('original request').digest();

test('forward migration preserves existing account identities, outcomes and retention timestamps exactly', async () => {
  const database = `anonymous_migration_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE DATABASE ${database}`);
  const address = new URL(url);
  address.pathname = `/${database}`;
  const pool = createPool(address.href);
  const up = async (name: string) => {
    const sql = await Bun.file(new URL(`../db/migrations/${name}`, import.meta.url)).text();
    await pool.query(sql.split('-- migrate:up')[1]!.split('-- migrate:down')[0]!);
  };
  try {
    await up('0001_core_partition.sql');
    await up('20261025050000_receipt.sql');
    const transaction = randomUUID();
    const created = new Date('2026-01-01T00:00:00.123Z');
    await pool.query(
      `INSERT INTO core.receipt(partition_no,actor_account_id,command_kind,idempotency_key,
      request_digest,epoch,position,transaction_id,response,created_at) VALUES(0,$1,'report.create','Account Key',$2,2,7,$3,$4,$5)`,
      [account, digest, transaction, { original: true }, created],
    );
    await pool.query(
      `INSERT INTO editorial.write_basis(partition_no,transaction_id,epoch,position,
      actor_account_id,client_id,requested_by,recorded_at) VALUES(0,$1,2,7,$2,'web','original principal',$3)`,
      [transaction, account, created],
    );
    const beforeReceipt = (await pool.query('SELECT * FROM core.receipt')).rows[0];
    const beforeBasis = (await pool.query('SELECT * FROM editorial.write_basis')).rows[0];
    await up('20261025095021_receipt_principal.sql');
    expect((await pool.query('SELECT * FROM core.receipt')).rows).toEqual([
      { ...beforeReceipt, principal_kind: 'account', principal_id: account },
    ]);
    expect((await pool.query('SELECT * FROM editorial.write_basis')).rows).toEqual([
      { ...beforeBasis, principal_kind: 'account', principal_id: account },
    ]);
    expect(
      await runCommand(
        pool,
        {
          partition: 0,
          receipt: {
            actorAccountId: account,
            kind: 'report.create',
            key: 'Account Key',
            digest,
          },
        },
        async () => {
          throw new Error('migrated replay ran an effect');
        },
      ),
    ).toEqual({
      value: { original: true },
      partition: 0,
      epoch: 2,
      position: 7n,
      transactionId: transaction,
      replayed: true,
    });
  } finally {
    await pool.end();
    await admin.query(`DROP DATABASE ${database} WITH (FORCE)`);
  }
});

test('receipt namespaces separate account and anonymous at the same partition/kind/key', async () => {
  const key = randomUUID();
  const receipt = { kind: 'report.create', key, digest };
  const body = async () => ({ value: randomUUID(), events: [event] });
  const accountInput = { partition: 100, receipt: { ...receipt, actorAccountId: account } };
  const anonymousInput = {
    ...principalCommandIdentity({ kind: 'anonymous' }),
    partition: 100,
    receipt,
    authorization: {
      action: 'report:create',
      resource: { route: 1600, id: account },
      async authorize() {
        return 'execute' as const;
      },
      denied: () => new Error('denied'),
    },
  };
  const first = await runCommand(admin, accountInput, body);
  const second = await runCommand(admin, anonymousInput, body);
  expect(second.replayed).toBe(false);
  expect(second.value).not.toBe(first.value);
  expect(await runCommand(admin, accountInput, body)).toEqual({ ...first, replayed: true });
  expect(await runCommand(admin, anonymousInput, body)).toEqual({ ...second, replayed: true });
  expect(
    (
      await admin.query(`SELECT principal_kind, principal_id FROM core.receipt
    WHERE partition_no=100 ORDER BY principal_kind`)
    ).rows,
  ).toEqual([
    { principal_kind: 'account', principal_id: account },
    { principal_kind: 'anonymous', principal_id: ANONYMOUS_PRINCIPAL_ID },
  ]);
});

test('storage rejects competing compatibility identities, non-nil anonymous and account-nil principals', async () => {
  for (const [kind, id, key] of [
    ['account', ANONYMOUS_PRINCIPAL_ID, randomUUID()],
    ['anonymous', account, randomUUID()],
    ['invented', account, randomUUID()],
    ['anonymous', ANONYMOUS_PRINCIPAL_ID, 'short'],
    ['anonymous', ANONYMOUS_PRINCIPAL_ID, 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA'],
  ]) {
    await expect(
      admin.query(
        `INSERT INTO core.receipt(partition_no,principal_kind,principal_id,command_kind,
      idempotency_key,request_digest,epoch,position,transaction_id,response)
      VALUES(100,$1,$2,'report.create',$3,$4,1,1,$5,'{}')`,
        [kind, id, key, digest, randomUUID()],
      ),
    ).rejects.toHaveProperty('code', '23514');
  }
  await expect(
    admin.query(`UPDATE core.receipt SET actor_account_id=$1 WHERE partition_no=100`, [account]),
  ).rejects.toHaveProperty('code', '428C9');
});
