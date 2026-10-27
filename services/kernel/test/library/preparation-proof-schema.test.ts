import { afterAll, beforeAll, expect, test } from 'bun:test';
import { openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';
let db: GrowthDatabase;
beforeAll(async () => {
  db = await openGrowthDatabase();
});
afterAll(async () => {
  await db?.close();
});
test('new preparation headers retain exact identity metadata and ready checkpoints retain native receipt locators', async () => {
  const cols = (
    await db.admin.query(
      "SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='library' AND table_name IN ('type_preparation_header','type_preparation_progress')",
    )
  ).rows;
  for (const name of ['source_identity', 'origin_identity'])
    expect(cols.some((x) => x.table_name === 'type_preparation_header' && x.column_name === name)).toBe(true);
  for (const name of ['last_receipt', 'last_transaction_id'])
    expect(cols.some((x) => x.table_name === 'type_preparation_progress' && x.column_name === name)).toBe(true);
  const checks = (
    await db.admin.query(
      "SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid IN ('library.type_preparation_header'::regclass,'library.type_preparation_progress'::regclass) AND contype='c'",
    )
  ).rows
    .map((x) => x.definition)
    .join(' ');
  for (const name of ['source_identity', 'origin_identity', 'last_receipt', 'last_transaction_id'])
    expect(checks).toContain(name);
  expect(checks).toContain('NOT VALID');
});
