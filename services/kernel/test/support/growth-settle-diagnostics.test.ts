import { afterAll, beforeAll, expect, test } from 'bun:test';
import { GrowthSettleInfrastructureError, openGrowthDatabase, settle, type GrowthDatabase } from './growth.ts';

const schema = 'growth_settle_diagnostics_test';
let db: GrowthDatabase;

beforeAll(async () => {
  db = await openGrowthDatabase();
  await db.admin.query(`CREATE SCHEMA ${schema}`);
});

afterAll(async () => {
  await db.admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await db.close();
});

test('settle reports actual VACUUM failures with database and relation context', async () => {
  const relation = `${schema}.missing`;
  let failure: unknown;
  try {
    await settle(db, { relations: [relation] });
  } catch (error) {
    failure = error;
  }

  expect(failure).toBeInstanceOf(GrowthSettleInfrastructureError);
  expect((failure as Error).message).toContain(`Could not settle database ${new URL(db.url).pathname.slice(1)}`);
  expect((failure as Error).message).toContain(`relation ${relation}`);
  expect((failure as Error).message).toContain('does not exist');
});
