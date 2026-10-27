import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { PoolClient } from 'pg';
import { newId } from '../../src/route/route.ts';
import { openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';
let db: GrowthDatabase;
beforeAll(async () => {
  db = await openGrowthDatabase();
});
afterAll(async () => {
  await db?.close();
});
async function header(
  overrides: Record<string, unknown> = {},
  client: Pick<PoolClient, 'query'> = db.admin,
  legacy = false,
) {
  const route = 0x6a30,
    account = newId(route),
    preparation = newId(route),
    digest = 'a'.repeat(64);
  const source = {
    sourceId: newId(2),
    partition: 0,
    epoch: 1,
    revision: '9007199254740993',
    transactionId: newId(2),
    redirect: null,
  };
  const original = {
    ...source,
    sourceId: newId(1),
    transactionId: newId(1),
  };
  const values = {
    route,
    account_id: account,
    preparation_id: preparation,
    binding_digest: digest,
    binding: JSON.stringify({
      accountId: account,
      subjectId: original.sourceId,
      requestKey: 'prepare',
      sourceId: source.sourceId,
      sourcePartition: 0,
      sourceEpoch: 1,
      sourcePosition: '1',
      ownerEpoch: '0',
    }),
    origin: JSON.stringify({ sourceId: original.sourceId, partition: 0, epoch: 1, position: '1', survivorId: null }),
    ...(!legacy && {
      source_identity: JSON.stringify(source),
      origin_identity: JSON.stringify(original),
    }),
    principal_namespace: JSON.stringify({ principalKind: 'account', principalId: account }),
    reservation_id: newId(route),
    input_byte_length: '9007199254740992',
    input_digest: Buffer.alloc(32),
    creation_transaction_id: newId(route),
    creation_receipt: JSON.stringify({
      partition: 0,
      principalKind: 'account',
      principalId: account,
      commandKind: 'library.type.prepare',
      idempotencyKey: 'prepare',
    }),
    creation_commitment: 'b'.repeat(64),
    ...overrides,
  };
  await client.query(
    `INSERT INTO library.type_preparation_header (${Object.keys(values).join(',')})
    VALUES (${Object.keys(values)
      .map((_, i) => `$${i + 1}`)
      .join(',')})`,
    Object.values(values),
  );
  return {
    route: values.route,
    account: values.account_id,
    preparation: values.preparation_id,
    digest: values.binding_digest,
    receipt: values.creation_receipt,
    transaction: values.creation_transaction_id,
    identities: { source_identity: source, origin_identity: original },
  };
}
type Header = Awaited<ReturnType<typeof header>>;
async function progress(h: Header) {
  return db.admin.query(
    `INSERT INTO library.type_preparation_progress
    (route,account_id,preparation_id,state,last_receipt,last_transaction_id) VALUES ($1,$2,$3,'pending',$4,$5)`,
    [h.route, h.account, h.preparation, h.receipt, h.transaction],
  );
}
async function slot(h: Header) {
  const values = [h.route, h.account, h.digest, h.preparation];
  return db.admin.query('INSERT INTO library.type_preparation_slot VALUES ($1,$2,$3,$4)', values);
}
test('preparation owner and preparation UUID routes reject mismatches and out-of-range routes', async () => {
  for (const route of [0, 65535]) {
    const h = await header({ route, account_id: newId(route), preparation_id: newId(route) });
    await progress(h);
    await slot(h);
  }
  for (const overrides of [{ route: -1 }, { route: 65536 }, { account_id: newId(1) }, { preparation_id: newId(1) }]) {
    await expect(header(overrides)).rejects.toMatchObject({ code: '23514' });
  }
  const h = await header();
  for (const invalid of [
    { ...h, route: -1 },
    { ...h, route: 65536 },
    { ...h, account: newId(1) },
    { ...h, preparation: newId(1) },
  ]) {
    await expect(progress(invalid)).rejects.toMatchObject({ code: '23514' });
    await expect(slot(invalid)).rejects.toMatchObject({ code: '23514' });
  }
});
test('immutable header validates provenance storage shapes without requiring a live reservation', async () => {
  for (const overrides of [
    { binding_digest: 'A'.repeat(64) },
    { binding_digest: 'a'.repeat(63) },
    { creation_commitment: 'z'.repeat(64) },
    { input_byte_length: -1 },
    { input_digest: Buffer.alloc(31) },
    { input_digest: Buffer.alloc(33) },
    ...['binding', 'origin', 'principal_namespace', 'creation_receipt'].flatMap((key) =>
      ['[]', 'null', '"text"'].map((value) => ({ [key]: value })),
    ),
  ]) {
    await expect(header(overrides)).rejects.toMatchObject({ code: '23514' });
  }
  const h = await header({ reservation_id: null, input_byte_length: 0 });
  await progress(h);
  await expect(
    db.admin.query(
      `UPDATE library.type_preparation_header SET input_byte_length=1
    WHERE route=$1 AND account_id=$2 AND preparation_id=$3`,
      [h.route, h.account, h.preparation],
    ),
  ).rejects.toMatchObject({ code: '23514' });
});
test('local preparation foreign keys isolate owners and bindings and require ordered retirement', async () => {
  const h = await header();
  for (const invalid of [
    { ...h, account: newId(h.route) },
    { ...h, preparation: newId(h.route) },
  ]) {
    await expect(progress(invalid)).rejects.toMatchObject({ code: '23503' });
    await expect(slot(invalid)).rejects.toMatchObject({ code: '23503' });
  }
  await expect(slot({ ...h, digest: 'c'.repeat(64) })).rejects.toMatchObject({ code: '23503' });
  await progress(h);
  await slot(h);
  const sameDigest = await header({ account_id: h.account });
  await expect(slot(sameDigest)).rejects.toMatchObject({ code: '23505' });
  const params = [h.route, h.account, h.preparation];
  const removeHeader = () =>
    db.admin.query(
      `DELETE FROM library.type_preparation_header
    WHERE route=$1 AND account_id=$2 AND preparation_id=$3`,
      params,
    );
  await expect(removeHeader()).rejects.toMatchObject({ code: '23503' });
  await db.admin.query(
    `DELETE FROM library.type_preparation_slot
    WHERE route=$1 AND account_id=$2 AND preparation_id=$3`,
    params,
  );
  await expect(removeHeader()).rejects.toMatchObject({ code: '23503' });
  await db.admin.query(
    `DELETE FROM library.type_preparation_progress
    WHERE route=$1 AND account_id=$2 AND preparation_id=$3`,
    params,
  );
  expect((await removeHeader()).rowCount).toBe(1);
});
test('ready progress requires a local published key and no enqueue; pending checkpoints stay nonnegative', async () => {
  const h = await header();
  await progress(h);
  const params = [h.route, h.account, h.preparation];
  const update = (assignment: string) =>
    db.admin.query(
      `UPDATE library.type_preparation_progress SET ${assignment}
    WHERE route=$1 AND account_id=$2 AND preparation_id=$3`,
      params,
    );
  const row = (
    await db.admin.query(
      `SELECT chunk,byte_offset,enqueue_pending FROM library.type_preparation_progress
    WHERE route=$1 AND account_id=$2 AND preparation_id=$3`,
      params,
    )
  ).rows[0];
  expect(row).toEqual({ chunk: '0', byte_offset: '0', enqueue_pending: false });
  for (const assignment of ['chunk=-1', 'byte_offset=-1', "state='unknown'", "state='ready'"]) {
    await expect(update(assignment)).rejects.toMatchObject({ code: '23514' });
  }
  const key = newId(h.route);
  await expect(
    db.admin.query(
      `UPDATE library.type_preparation_progress SET type_id=$4
    WHERE route=$1 AND account_id=$2 AND preparation_id=$3`,
      [...params, key],
    ),
  ).rejects.toMatchObject({ code: '23503' });
  await db.admin.query(
    `INSERT INTO library.shelf_type_value
    (route,account_id,type_id,full_type,byte_length,json_byte_length) VALUES ($1,$2,$3,'schema:Book',11,13)`,
    [h.route, h.account, key],
  );
  await db.admin.query(
    `UPDATE library.type_preparation_progress SET type_id=$4,enqueue_pending=true,
    chunk=9007199254740992,byte_offset=9007199254740992
    WHERE route=$1 AND account_id=$2 AND preparation_id=$3`,
    [...params, key],
  );
  await expect(update("state='ready'")).rejects.toMatchObject({ code: '23514' });
  expect((await update("state='ready',enqueue_pending=false")).rowCount).toBe(1);
  await expect(update('enqueue_pending=true')).rejects.toMatchObject({ code: '23514' });
  expect((await update("state='cancelled'")).rowCount).toBe(1);
});
test('pending index enumerates only pending enqueues by owner and preparation', async () => {
  const result = await db.admin.query<{ indexdef: string }>(`SELECT indexdef FROM pg_indexes
    WHERE schemaname='library' AND indexname='type_preparation_pending'`);
  expect(result.rows).toHaveLength(1);
  expect(result.rows[0]!.indexdef).toContain('(route, account_id, preparation_id)');
  expect(result.rows[0]!.indexdef).toContain("WHERE (enqueue_pending AND (state = 'pending'::text))");
});

// These fixtures exercise storage only; metadata and receipt JSON do not prove authority.
test('new header identities reject missing values and JSON nonobjects and remain independently immutable', async () => {
  await expect(header({}, db.admin, true)).rejects.toMatchObject({ code: '23514' });
  for (const column of ['source_identity', 'origin_identity']) {
    for (const value of [null, 'null', '[]', '"text"', '1', 'true'])
      await expect(header({ [column]: value })).rejects.toMatchObject({ code: '23514' });
  }
  const h = await header();
  const params = [h.route, h.account, h.preparation];
  const row = await db.admin.query(
    `SELECT source_identity,origin_identity FROM library.type_preparation_header
    WHERE route=$1 AND account_id=$2 AND preparation_id=$3`,
    params,
  );
  expect(row.rows[0]).toEqual(h.identities);
  for (const column of ['source_identity', 'origin_identity'])
    await expect(
      db.admin.query(
        `UPDATE library.type_preparation_header SET ${column}='{}'
      WHERE route=$1 AND account_id=$2 AND preparation_id=$3`,
        params,
      ),
    ).rejects.toMatchObject({ code: '23514' });
});

test('pending permits absent paired proof and ready inserts and updates require an object locator and transaction', async () => {
  const h = await header(),
    type = newId(h.route);
  const params = [h.route, h.account, h.preparation];
  const where = 'WHERE route=$1 AND account_id=$2 AND preparation_id=$3';
  await db.admin.query(
    `INSERT INTO library.shelf_type_value
    (route,account_id,type_id,full_type,byte_length,json_byte_length) VALUES ($1,$2,$3,'schema:Book',11,13)`,
    [h.route, h.account, type],
  );
  const insert = (state: string) =>
    db.admin.query(
      `INSERT INTO library.type_preparation_progress
    (route,account_id,preparation_id,state,type_id) VALUES ($1,$2,$3,$4,$5)`,
      [...params, state, type],
    );
  await expect(insert('ready')).rejects.toMatchObject({ code: '23514' });
  await insert('pending');
  const read = () =>
    db.admin.query(`SELECT last_receipt,last_transaction_id FROM library.type_preparation_progress ${where}`, params);
  expect((await read()).rows[0]).toEqual({ last_receipt: null, last_transaction_id: null });
  const update = (assignment: string, extra: unknown[] = []) =>
    db.admin.query(`UPDATE library.type_preparation_progress SET ${assignment} ${where}`, [...params, ...extra]);
  for (const [receipt, tx] of [
    [null, h.transaction],
    [h.receipt, null],
    ...['null', '[]', '"text"', '1', 'true'].map((value) => [value, h.transaction]),
  ])
    await expect(update('last_receipt=$4,last_transaction_id=$5', [receipt, tx])).rejects.toMatchObject({
      code: '23514',
    });
  await expect(update("state='ready'")).rejects.toMatchObject({ code: '23514' });
  await update('last_receipt=$4,last_transaction_id=$5', [h.receipt, h.transaction]);
  expect((await update("state='ready'")).rowCount).toBe(1);
  expect((await read()).rows[0]).toEqual({ last_receipt: JSON.parse(h.receipt), last_transaction_id: h.transaction });
  await expect(update('last_receipt=NULL,last_transaction_id=NULL')).rejects.toMatchObject({ code: '23514' });
});

test('forward proof migration preserves historical NULL evidence without validation and keeps old headers immutable', async () => {
  const client = await db.admin.connect();
  await client.query('BEGIN');
  try {
    await client.query(`ALTER TABLE library.type_preparation_header DROP COLUMN source_identity, DROP COLUMN origin_identity;
      ALTER TABLE library.type_preparation_progress DROP COLUMN last_receipt, DROP COLUMN last_transaction_id;`);
    const h = await header({}, client, true),
      type = newId(h.route);
    const params = [h.route, h.account, h.preparation];
    await client.query(
      `INSERT INTO library.shelf_type_value
      (route,account_id,type_id,full_type,byte_length,json_byte_length) VALUES ($1,$2,$3,'schema:Book',11,13)`,
      [h.route, h.account, type],
    );
    await client.query(
      `INSERT INTO library.type_preparation_progress (route,account_id,preparation_id,state,type_id)
      VALUES ($1,$2,$3,'ready',$4)`,
      [...params, type],
    );
    const migration = new URL(
      '../../db/library/migrations/20261027153846_library_preparation_identity_proof.sql',
      import.meta.url,
    );
    await client.query((await Bun.file(migration).text()).split('-- migrate:down')[0]!);
    const stored = await client.query(
      `SELECT source_identity,origin_identity,last_receipt,last_transaction_id
      FROM library.type_preparation_header JOIN library.type_preparation_progress USING (route,account_id,preparation_id)
      WHERE route=$1 AND account_id=$2 AND preparation_id=$3`,
      params,
    );
    expect(Object.values(stored.rows[0]!)).toEqual([null, null, null, null]);
    const checks = await client.query(`SELECT convalidated FROM pg_constraint WHERE conname IN
      ('type_preparation_header_identity_check','type_preparation_progress_receipt_check','type_preparation_progress_ready_proof_check')`);
    expect(checks.rows).toEqual(Array(3).fill({ convalidated: false }));
    const columns = await client.query(`SELECT column_default,is_nullable FROM information_schema.columns
      WHERE table_schema='library' AND column_name IN ('source_identity','origin_identity','last_receipt','last_transaction_id')`);
    expect(columns.rows).toEqual(Array(4).fill({ column_default: null, is_nullable: 'YES' }));
    await client.query('SAVEPOINT immutable');
    await expect(
      client.query(
        `UPDATE library.type_preparation_header SET source_identity='{}',origin_identity='{}'
      WHERE route=$1 AND account_id=$2 AND preparation_id=$3`,
        params,
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await client.query('ROLLBACK TO SAVEPOINT immutable');
    await expect(
      client.query(
        `UPDATE library.type_preparation_progress SET chunk=chunk
      WHERE route=$1 AND account_id=$2 AND preparation_id=$3`,
        params,
      ),
    ).rejects.toMatchObject({ code: '23514' });
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
});
