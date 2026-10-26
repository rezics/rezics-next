import { afterAll, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { Pool } from 'pg';
import { dropTestDatabase } from './drop-test-database.ts';

const base = process.env.DATABASE_URL;
if (!base) throw new Error('DATABASE_URL must name the migrated test database');
const adminUrl = new URL(base);
adminUrl.pathname = '/postgres';
const admin = new Pool({ connectionString: adminUrl.toString(), max: 1 });
const created: string[] = [];
const left: Pool[] = [];
afterAll(async () => {
  for (const pool of left) await pool.end();
  for (const name of created) await dropTestDatabase(admin, name);
  await admin.end();
});

async function create(): Promise<string> {
  const name = `drop_probe_${Bun.randomUUIDv7().replaceAll('-', '')}`;
  created.push(name);
  await admin.query(`CREATE DATABASE ${name}`);
  return name;
}

function open(name: string, options: { applicationName?: string; max?: number } = {}): Pool {
  const url = new URL(base!);
  url.pathname = `/${name}`;
  return new Pool({
    connectionString: url.toString(),
    max: options.max ?? 4,
    application_name: options.applicationName,
  });
}

test('dropTestDatabase drops a database whose pools were just ended without any client receiving 57P01', async () => {
  const errors: unknown[] = [];
  for (let round = 0; round < 5; round++) {
    const name = await create();
    const pools = [open(name), open(name)];
    for (const pool of pools) {
      pool.on('error', (error) => errors.push(error));
      pool.on('connect', (client) => client.on('error', (error) => errors.push(error)));
    }
    await Promise.all(pools.flatMap((pool) => Array.from({ length: 4 }, () => pool.query('SELECT pg_sleep(0.02)'))));
    await Promise.all(pools.map((pool) => pool.end()));
    await dropTestDatabase(admin, name);
    const found = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    expect(found.rowCount).toBe(0);
  }
  // A late FATAL would arrive as a socket event after the drop.
  await new Promise((done) => setTimeout(done, 200));
  expect(errors).toEqual([]);
});

test('dropTestDatabase fails at its bound with the pid, application_name, state and query of a client backend still connected', async () => {
  const name = await create();
  const pool = open(name, { applicationName: 'drop_probe_holder', max: 1 });
  left.push(pool);
  const { rows } = await pool.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
  const pid = rows[0]!.pid;
  const started = Date.now();
  const failure = await dropTestDatabase(admin, name, { boundMs: 300, pollMs: 20 }).then(
    () => undefined,
    (error: Error) => error,
  );
  expect(failure).toBeInstanceOf(Error);
  expect(Date.now() - started).toBeGreaterThanOrEqual(300);
  const message = failure!.message;
  expect(message).toContain(name);
  expect(message).toContain(`pid ${pid}`);
  expect(message).toContain('drop_probe_holder');
  expect(message).toContain('idle');
  expect(message).toContain('SELECT pg_backend_pid() AS pid');
  const found = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
  expect(found.rowCount).toBe(1);
  await pool.end();
  left.pop();
  await dropTestDatabase(admin, name);
});

const testRoot = resolve(import.meta.dir, '..');
const forcedDrop = /DROP\s+DATABASE[^;`'"]*WITH\s*\(\s*FORCE\s*\)/i;
const helper = ['support/drop-test-database.ts', 'support/drop-test-database.test.ts'];
// Files of other owners that still hold a raw forced drop; each owner deletes its entries as it moves them, and the
// list goes when it is empty.
const allowlist = [
  'commerce/governance.test.ts',
  'commerce/payout-mark-paid.test.ts',
  'commerce/support/outcome-driver.ts',
  'library/support/outcome-driver.ts',
  'semantic/governance-actions.test.ts',
];

const sources = new Map<string, string>();
for (const file of new Bun.Glob('**/*.ts').scanSync({ cwd: testRoot })) {
  sources.set(relative(testRoot, resolve(testRoot, file)), readFileSync(resolve(testRoot, file), 'utf8'));
}
const raw = [...sources]
  .filter(([file, source]) => !helper.includes(file) && forcedDrop.test(source))
  .map(([file]) => file);

test('the guard fails on a raw DROP DATABASE ... WITH (FORCE) under services/kernel/test outside the helper and the allowlist', () => {
  expect(forcedDrop.test('await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)')).toBe(true);
  expect(forcedDrop.test('DROP  DATABASE x\n  WITH ( force )')).toBe(true);
  expect(forcedDrop.test('DROP DATABASE x')).toBe(false);
  expect(raw.filter((file) => !allowlist.includes(file)).sort()).toEqual([]);
  expect(allowlist.filter((file) => !raw.includes(file))).toEqual([]);
});

test('every content, community and root-level file drops its databases through the helper', () => {
  const scoped = [...sources.keys()].filter(
    (file) => file.startsWith('content/') || file.startsWith('community/') || !file.includes('/'),
  );
  expect(scoped.length).toBeGreaterThan(0);
  expect(scoped.filter((file) => raw.includes(file))).toEqual([]);
});
