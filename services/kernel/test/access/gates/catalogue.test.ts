import { afterAll, expect, test } from 'bun:test';

await import('reylo/register');
const { createPool } = await import('../../../src/database/pool.ts');
const { readExposure } = await import('../../../src/access/gates/catalogue.ts');

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(databaseUrl);
const group = `catalogue_${Bun.randomUUIDv7().replaceAll('-', '').replace(/[0-9]/g, 'a')}`;
const transactionId = Bun.randomUUIDv7();
const at = new Date('2026-01-01T00:00:00.000Z');
const deadline = Date.now() + 10_000;

afterAll(async () => {
  await pool.query('DELETE FROM access.exposure_opening WHERE "group" = $1', [group]);
  await pool.end();
});

test('the exposure catalogue enforces valid groups and temporal non-overlap and reads half-open openings at T', async () => {
  expect(await readExposure(pool, group, at, deadline)).toMatchObject({ open: false, at: at.toISOString() });

  await pool.query(
    `INSERT INTO access.exposure_opening ("group", valid, transaction_id)
     VALUES ($1, tstzrange($2::timestamptz, $3::timestamptz, '[)'), $4)`,
    [group, at.toISOString(), '2026-01-02T00:00:00.000Z', transactionId],
  );
  expect(await readExposure(pool, group, new Date(at.getTime() - 1), deadline)).toMatchObject({ open: false });
  expect(await readExposure(pool, group, at, deadline)).toMatchObject({ open: true });
  expect(await readExposure(pool, group, new Date('2026-01-01T23:59:59.999Z'), deadline)).toMatchObject({
    open: true,
  });
  expect(await readExposure(pool, group, new Date('2026-01-02T00:00:00.000Z'), deadline)).toMatchObject({
    open: false,
  });

  await pool.query(
    `INSERT INTO access.exposure_opening ("group", valid, transaction_id)
     VALUES ($1, tstzrange($2::timestamptz, NULL, '[)'), $3)`,
    [group, '2026-01-02T00:00:00.000Z', Bun.randomUUIDv7()],
  );
  expect(await readExposure(pool, group, new Date('2026-01-02T00:00:00.000Z'), deadline)).toMatchObject({
    open: true,
  });

  await expect(
    pool.query(
      `INSERT INTO access.exposure_opening ("group", valid, transaction_id)
       VALUES ($1, tstzrange($2::timestamptz, NULL, '[)'), $3)`,
      [group, '2026-01-01T12:00:00.000Z', Bun.randomUUIDv7()],
    ),
  ).rejects.toThrow();
  await expect(
    pool.query(
      `INSERT INTO access.exposure_opening ("group", valid, transaction_id)
       VALUES ('gate:any', tstzrange($1::timestamptz, NULL, '[)'), $2)`,
      [at.toISOString(), Bun.randomUUIDv7()],
    ),
  ).rejects.toThrow();
});
