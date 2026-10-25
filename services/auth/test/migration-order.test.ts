import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { migrate, testDatabase } from '../scripts/database.ts';

test('a new lower UTC migration upgrades applied future history exactly once', async () => {
  const temporaryRoot = resolve(import.meta.dir, '../../../.temp');
  mkdirSync(temporaryRoot, { recursive: true });
  const migrationsDirectory = mkdtempSync(resolve(temporaryRoot, 'auth-migration-order-'));
  let database: ReturnType<typeof testDatabase> | undefined;
  let pool: Pool | undefined;
  try {
    // Always own a separate migrated fixture, even when the check supplies another suite's URL.
    database = testDatabase();
    pool = new Pool({ connectionString: database.url });
    const history = async () =>
      (
        await pool!.query<{ version: string }>('SELECT version FROM public.schema_migrations ORDER BY version')
      ).rows.map(({ version }) => version);
    const baseline = await history();
    const historicalVersion = '20990101000000';
    const newVersion = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
    expect(newVersion < historicalVersion).toBe(true);

    writeFileSync(
      resolve(migrationsDirectory, `${historicalVersion}_historical.sql`),
      `-- migrate:up
CREATE TABLE migration_order_effects (effect text NOT NULL);
INSERT INTO migration_order_effects VALUES ('historical');
-- migrate:down
DROP TABLE migration_order_effects;
`,
    );
    migrate(database.url, migrationsDirectory);
    const historicalHistory = [...baseline, historicalVersion].sort();
    expect(await history()).toEqual(historicalHistory);
    expect((await pool.query('SELECT effect FROM migration_order_effects')).rows).toEqual([{ effect: 'historical' }]);

    // Simulate an existing future-stamped deployment receiving a migration created now in UTC.
    writeFileSync(
      resolve(migrationsDirectory, `${newVersion}_new.sql`),
      `-- migrate:up
INSERT INTO migration_order_effects VALUES ('new');
-- migrate:down
DELETE FROM migration_order_effects WHERE effect = 'new';
`,
    );
    const upgradedHistory = [...historicalHistory, newVersion].sort();
    const effects = [{ effect: 'historical' }, { effect: 'new' }];
    migrate(database.url, migrationsDirectory);
    expect(await history()).toEqual(upgradedHistory);
    expect((await pool.query('SELECT effect FROM migration_order_effects ORDER BY effect')).rows).toEqual(effects);

    migrate(database.url, migrationsDirectory);
    expect(await history()).toEqual(upgradedHistory);
    expect((await pool.query('SELECT effect FROM migration_order_effects ORDER BY effect')).rows).toEqual(effects);
  } finally {
    try {
      await pool?.end();
    } finally {
      try {
        database?.close();
      } finally {
        rmSync(migrationsDirectory, { recursive: true, force: true });
      }
    }
  }
}, 30000);
