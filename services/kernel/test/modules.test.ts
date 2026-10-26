import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import pg from 'pg';
import { migrate, schemaDump, schemaDumps } from '../scripts/database.ts';
import { dropTestDatabase } from './support/drop-test-database.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
const admin = new pg.Pool({ connectionString: databaseUrl, max: 1 });
const name = `kernel_modules_${process.pid}`;
const scratch = new URL(databaseUrl);
scratch.pathname = `/${name}`;
const url = scratch.href;
const root = mkdtempSync(join(tmpdir(), 'kernel-modules-'));
// Schema dumps use the running database container, but migrations and database setup still need a larger budget.
const timeout = 60_000;
function migration(path: string, up: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), `-- migrate:up\n${up}\n\n-- migrate:down\n`);
}
beforeAll(async () => {
  await admin.query(`CREATE DATABASE ${name}`);
});
afterAll(async () => {
  await dropTestDatabase(admin, name);
  await admin.end();
  rmSync(root, { recursive: true, force: true });
});

test(
  'migrations from every module directory apply in version order, also one that merges behind',
  async () => {
    migration(
      'db/migrations/20261025000200_base.sql',
      'CREATE SCHEMA base;\nCREATE TABLE base.item (route integer PRIMARY KEY);',
    );
    migration(
      'db/extra/migrations/20261025000100_extra.sql',
      'CREATE SCHEMA extra;\nCREATE TABLE extra.item (route integer PRIMARY KEY, base integer);',
    );
    migrate(url, root);
    migration('db/extra/migrations/20261025000150_label.sql', 'ALTER TABLE extra.item ADD COLUMN label text;');
    migrate(url, root);
    migrate(url, root);
    const client = new pg.Client(url);
    await client.connect();
    try {
      const versions = await client.query('SELECT version FROM public.schema_migrations ORDER BY version');
      expect(versions.rows.map((row) => row.version)).toEqual(['20261025000100', '20261025000150', '20261025000200']);
      const columns = await client.query(
        "SELECT column_name FROM information_schema.columns WHERE table_schema = 'extra' ORDER BY ordinal_position",
      );
      expect(columns.rows.map((row) => row.column_name)).toEqual(['route', 'base', 'label']);
    } finally {
      await client.end();
    }
  },
  timeout,
);

test(
  'each module schema dumps to its own file and the kernel dump leaves it out',
  () => {
    const dumps = schemaDumps(url, root);
    expect(Object.keys(dumps).sort()).toEqual(['db/extra/schema.sql', 'db/schema.sql']);
    expect(dumps['db/schema.sql']).toContain('CREATE TABLE base.item');
    expect(dumps['db/schema.sql']).toContain('CREATE TABLE public.schema_migrations');
    expect(dumps['db/schema.sql']).not.toContain('extra.item');
    expect(dumps['db/schema.sql']).not.toContain('SCHEMA extra');
    expect(dumps['db/extra/schema.sql']).toContain('CREATE SCHEMA extra;');
    expect(dumps['db/extra/schema.sql']).toContain('label text');
    expect(dumps['db/extra/schema.sql']).not.toContain('base.item');
    expect(schemaDump(url, root)).toBe(dumps['db/schema.sql']!);
  },
  timeout,
);

test(
  'every workspace dump matches its committed file',
  async () => {
    const dumps = schemaDumps(databaseUrl);
    expect(Object.keys(dumps)).toContain('db/schema.sql');
    for (const [path, dump] of Object.entries(dumps)) {
      expect(await Bun.file(new URL(`../${path}`, import.meta.url)).text()).toBe(dump);
    }
  },
  timeout,
);

test(
  'schema dumps run pg_dump in the running database container instead of starting a new one',
  async () => {
    const docker = Bun.which('docker');
    if (!docker) throw new Error('docker must be on PATH');
    const shim = mkdtempSync(join(tmpdir(), 'kernel-docker-'));
    const calls = join(shim, 'calls');
    writeFileSync(join(shim, 'docker'), `#!/bin/sh\nprintf '%s\\n' "$1" >> '${calls}'\nexec '${docker}' "$@"\n`, {
      mode: 0o755,
    });
    const path = process.env.PATH;
    process.env.PATH = `${shim}:${path}`;
    try {
      const dumps = schemaDumps(databaseUrl);
      for (const [file, dump] of Object.entries(dumps)) {
        expect(await Bun.file(new URL(`../${file}`, import.meta.url)).text()).toBe(dump);
      }
      const subcommands = readFileSync(calls, 'utf8').trim().split('\n');
      expect(subcommands).toContain('exec');
      expect(subcommands.filter((subcommand) => ['run', 'create', 'start'].includes(subcommand))).toEqual([]);
    } finally {
      process.env.PATH = path;
      rmSync(shim, { recursive: true, force: true });
    }
  },
  timeout,
);
