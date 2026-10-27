import { afterAll, beforeAll, expect, test } from 'bun:test';
import { newId } from '../../src/route/route.ts';
import { openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';
let db: GrowthDatabase;
beforeAll(async () => {
  db = await openGrowthDatabase();
});
afterAll(async () => {
  await db?.close();
});
async function header(overrides: Record<string, unknown> = {}) {
  const route = 0x6a30,
    account = newId(route),
    preparation = newId(route),
    digest = 'a'.repeat(64);
  const values = {
    route,
    account_id: account,
    preparation_id: preparation,
    binding_digest: digest,
    binding: JSON.stringify({
      accountId: account,
      subjectId: newId(1),
      requestKey: 'prepare',
      sourceId: newId(2),
      sourcePartition: 0,
      sourceEpoch: 1,
      sourcePosition: '1',
      ownerEpoch: '0',
    }),
    origin: JSON.stringify({ sourceId: newId(1), partition: 0, epoch: 1, position: '1', survivorId: null }),
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
  await db.admin.query(
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
  };
}
type Header = Awaited<ReturnType<typeof header>>;
async function progress(h: Header) {
  return db.admin.query(
    `INSERT INTO library.type_preparation_progress
    (route,account_id,preparation_id,state) VALUES ($1,$2,$3,'pending')`,
    [h.route, h.account, h.preparation],
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
