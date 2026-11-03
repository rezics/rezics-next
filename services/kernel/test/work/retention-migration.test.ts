import { afterAll, beforeAll, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { installDbosSchema, migrate } from '../../scripts/database.ts';
import { WORKFLOW_RETENTION_SELECTOR_INDEX } from '../../src/work/retention-selector.ts';
import { dropTestDatabase } from '../support/drop-test-database.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');

const kernelRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const migrationFile = resolve(kernelRoot, 'db/migrations/20261103020222_workflow_retention_selector.sql');
const timeout = 120_000;
const admin = new pg.Pool({ connectionString: databaseUrl, max: 1 });
const names: string[] = [];

beforeAll(async () => {
  await admin.query('SELECT 1');
});

afterAll(async () => {
  for (const name of names) await dropTestDatabase(admin, name);
  await admin.end();
});

function scratchUrl(name: string): string {
  const url = new URL(databaseUrl);
  url.pathname = `/${name}`;
  return url.href;
}

async function createScratch(label: string): Promise<{ name: string; url: string }> {
  const name = `kernel_retention_${label}_${process.pid}`;
  names.push(name);
  await admin.query(`CREATE DATABASE ${name}`);
  return { name, url: scratchUrl(name) };
}

async function withClient<T>(url: string, run: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client(url);
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.end();
  }
}

async function indexDefinition(url: string): Promise<string | undefined> {
  return withClient(url, async (client) => {
    const result = await client.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
        WHERE schemaname = 'dbos' AND indexname = $1`,
      [WORKFLOW_RETENTION_SELECTOR_INDEX],
    );
    return result.rows[0]?.indexdef;
  });
}

function expectSelectorIndex(definition: string | undefined): void {
  expect(definition).toEqual(expect.stringContaining(WORKFLOW_RETENTION_SELECTOR_INDEX));
  expect(definition).toEqual(expect.stringContaining('application_name'));
  expect(definition).toEqual(expect.stringContaining('completed_at'));
  expect(definition).toEqual(expect.stringContaining('workflow_uuid'));
  for (const status of ['SUCCESS', 'ERROR', 'CANCELLED', 'MAX_RECOVERY_ATTEMPTS_EXCEEDED']) {
    expect(definition).toEqual(expect.stringContaining(status));
  }
}

test(
  'fresh setup installs the retention selector after the SDK table and repeats preserve it',
  async () => {
    const { url } = await createScratch('fresh');
    migrate(url);
    const installed = await indexDefinition(url);
    expectSelectorIndex(installed);
    migrate(url);
    expect(await indexDefinition(url)).toBe(installed);
    installDbosSchema(url);
    expect(await indexDefinition(url)).toBe(installed);
  },
  timeout,
);

test(
  'an existing SDK schema receives the selector on upgrade',
  async () => {
    const { url } = await createScratch('upgrade');
    installDbosSchema(url);
    expect(await indexDefinition(url)).toBeUndefined();
    migrate(url);
    expectSelectorIndex(await indexDefinition(url));
  },
  timeout,
);

test(
  'the selector migration refuses an absent workflow_status table',
  async () => {
    const { url } = await createScratch('missing');
    const up = readFileSync(migrationFile, 'utf8').split('-- migrate:up')[1]?.split('-- migrate:down')[0];
    expect(up).toBeDefined();
    await withClient(url, async (client) => {
      await expect(client.query(up!)).rejects.toMatchObject({ code: '42P01' });
    });
  },
  timeout,
);
