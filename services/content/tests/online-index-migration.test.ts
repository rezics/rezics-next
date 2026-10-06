import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Pool } from 'pg';
import { migrateContent } from '../src/migrate.ts';

const temporary = resolve(import.meta.dir, '../../../.temp');
const marker = '-- migrate: concurrent-index content.online_test\n';
const online = 'CREATE INDEX CONCURRENTLY online_test ON content.online_source (id);';

function directory(files: Record<string, string>) {
  mkdirSync(temporary, { recursive: true });
  const path = mkdtempSync(join(temporary, 'online-index-migration-'));
  for (const [name, sql] of Object.entries(files)) writeFileSync(join(path, name), sql);
  return path;
}

test.each([`${online} SELECT 1;`, `${online} ${online}`, 'SELECT 1;',
  online.replace(' CONCURRENTLY', '')])('Concurrent-index files reject all but one online CREATE before connecting: %s', async sql => {
  const path = directory({ '871_online_test.sql': marker + sql });
  let connected = false;
  const pool = { connect: async () => { connected = true; throw new Error('Should not connect'); } } as unknown as Pool;
  try {
    await expect(migrateContent(pool, path)).rejects.toThrow('exactly one CREATE INDEX CONCURRENTLY');
    expect(connected).toBe(false);
  } finally { rmSync(path, { recursive: true, force: true }); }
});

test('An online build failure preserves preceding committed migration receipts and retries only the missing version', async () => {
  const path = directory({ '870_online_source.sql': 'CREATE TABLE content.online_source (id integer);',
    '871_online_test.sql': marker + online + '\n-- A comment; is not another statement.' });
  let applied: number[] = [], pending: number[] = [], fail = true, sourceExists = false, pendingSource = false;
  const queries: string[] = [];
  const client = {
    async query(sql: string, params?: unknown[]) {
      queries.push(sql);
      if (sql === 'BEGIN') { pending = [...applied]; pendingSource = sourceExists; }
      if (sql === 'COMMIT') { applied = [...pending]; sourceExists = pendingSource; }
      if (sql === 'ROLLBACK') { pending = [...applied]; pendingSource = sourceExists; }
      if (sql === 'CREATE TABLE content.online_source (id integer);') pendingSource = true;
      if (sql.startsWith('SELECT version FROM')) return { rows: applied.map(version => ({ version })) };
      if (sql.startsWith('INSERT INTO content.schema_migration')) pending.push(params![0] as number);
      if (sql.includes(online) && fail) throw new Error('online build cancelled');
      return { rows: [] };
    },
    release() {},
  };
  const pool = { connect: async () => client } as unknown as Pool;
  try {
    await expect(migrateContent(pool, path)).rejects.toThrow('online build cancelled');
    expect(sourceExists).toBe(true);
    expect(applied).toEqual([870]);
    expect(queries.at(-1)).toContain('pg_advisory_unlock');
    fail = false;
    queries.length = 0;
    expect(await migrateContent(pool, path)).toEqual([871]);
    expect(applied).toEqual([870, 871]);
    expect(queries).not.toContain('CREATE TABLE content.online_source (id integer);');
  } finally { rmSync(path, { recursive: true, force: true }); }
});
