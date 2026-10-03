import { migrationVersion, schemaFiles } from '../../../scripts/qa/schema-files.ts';
import { expect, test } from 'bun:test';
import { resolve } from 'node:path';
import type { Pool } from 'pg';
import { migrateContent } from '../src/migrate.ts';

const root = resolve(import.meta.dir, '../../..');
const local = schemaFiles(root, 'content').map(migrationVersion);

function fakePool(applied: number[]) {
  const inserted: number[] = [];
  const client = {
    async query(sql: string, params?: unknown[]) {
      if (sql.startsWith('SELECT version FROM content.schema_migration')) {
        return { rows: applied.map(version => ({ version })) };
      }
      if (sql.startsWith('INSERT INTO content.schema_migration')) inserted.push(params![0] as number);
      return { rows: [] };
    },
    release() {},
  };
  return { pool: { connect: async () => client } as unknown as Pool, inserted };
}

test('a lower migration merged after higher ones were applied is applied, in version order', async () => {
  const [first, second, third, ...rest] = local;
  const { pool, inserted } = fakePool([first!, third!]);
  await migrateContent(pool);
  expect(inserted).toEqual([second!, ...rest]);
});

test('an applied migration missing locally still stops startup', async () => {
  const { pool } = fakePool([...local, local.at(-1)! + 1]);
  await expect(migrateContent(pool)).rejects.toThrow('Content schema history differs from local migrations');
});
