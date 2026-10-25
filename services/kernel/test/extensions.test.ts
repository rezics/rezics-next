import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import pg from 'pg';
import { moduleExtensionFiles } from '../scripts/database.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
const root = mkdtempSync(join(tmpdir(), 'kernel-extensions-'));
function file(path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}
afterAll(() => rmSync(root, { recursive: true, force: true }));

test('kernel migrations install btree_gist once for the whole database', async () => {
  const client = new pg.Client(databaseUrl);
  await client.connect();
  try {
    const installed = await client.query(
      "SELECT extnamespace::regnamespace::text AS schema FROM pg_extension WHERE extname = 'btree_gist'",
    );
    expect(installed.rows).toEqual([{ schema: 'public' }]);
    await client.query('BEGIN');
    try {
      await client.query('CREATE SCHEMA extension_probe');
      await client.query('SET LOCAL search_path = extension_probe');
      await client.query(
        'CREATE TABLE extension_probe.membership (route integer, member uuid, valid tstzrange, PRIMARY KEY (route, member, valid WITHOUT OVERLAPS))',
      );
    } finally {
      await client.query('ROLLBACK');
    }
  } finally {
    await client.end();
  }
});

test('a module migration that creates an extension is reported', () => {
  file(
    'db/migrations/20261025000000_core.sql',
    '-- migrate:up\nCREATE EXTENSION IF NOT EXISTS pg_trgm;\n\n-- migrate:down\n',
  );
  file(
    'db/clean/migrations/20261025000100_clean.sql',
    '-- migrate:up\n-- create extension is for the kernel\nCREATE SCHEMA clean;\n\n-- migrate:down\n',
  );
  file('db/greedy/migrations/20261025000200_tables.sql', '-- migrate:up\nCREATE SCHEMA greedy;\n\n-- migrate:down\n');
  file(
    'db/greedy/migrations/20261025000300_search.sql',
    '-- migrate:up\ncreate\n  extension if not exists pg_trgm with schema greedy;\n\n-- migrate:down\n',
  );
  expect(moduleExtensionFiles(root)).toEqual(['db/greedy/migrations/20261025000300_search.sql']);
});
