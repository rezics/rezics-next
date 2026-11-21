import { afterAll, beforeAll, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { createEconomyLedger } from '../../src/economy/ledger.ts';
import { bookFixtureDatabase } from './fixtures/book-reconciliation-native.ts';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL must name the migrated test database');
const fixtureUrl = process.env.DATABASE_URL;
const credential = 'ECONOMY_RECONCILIATION_DATABASE_URL';
const admin = new Pool({ connectionString: fixtureUrl });
const database = bookFixtureDatabase(admin);
const tag = crypto.randomUUID().replaceAll('-', '');
const reader = `economy_reader_${tag}`;
const denied = `economy_denied_${tag}`;
const password = crypto.randomUUID().replaceAll('-', '');
const bookId = `cli:${tag}`;
const damagedBook = `cli:damaged:${tag}`;
const assetId = 'audit-demo';
const walletId = crypto.randomUUID();
const script = resolve(import.meta.dir, '../../scripts/economy-book-audit.ts');
const created: string[] = [];

function roleUrl(user: string): URL {
  const url = new URL(fixtureUrl);
  url.username = user;
  url.password = password;
  url.search = '?sslmode=disable';
  return url;
}

beforeAll(async () => {
  for (const user of [reader, denied]) {
    await admin.query(`CREATE ROLE "${user}" LOGIN PASSWORD '${password}'`);
    created.push(user);
    await admin.query(`GRANT USAGE ON SCHEMA economy TO "${user}"`);
  }
  await admin.query(`GRANT SELECT ON TABLE economy.asset, economy.entry, economy.hold_allocation, economy.hold,
    economy.creator_payout, economy.funding_control_account, economy.position, economy.funding_intent,
    economy.pending_deposit, economy.journal TO "${reader}"`);
  for (const book of [bookId, damagedBook]) {
    const ledger = createEconomyLedger(database, book);
    expect(await ledger.provisionAsset({ id: assetId, scale: 2, transferable: true })).toMatchObject({ kind: 'ok' });
    expect(await ledger.issue({ assetId, accountId: walletId, operationId: 'opener', amount: '71' })).toMatchObject({
      kind: 'ok',
    });
  }
  await admin.query(
    `UPDATE economy.position SET posted = posted + 1 WHERE book_id = $1 AND asset_id = $2 AND account_id = $3`,
    [damagedBook, assetId, walletId],
  );
});

afterAll(async () => {
  try {
    for (const user of created) {
      await admin.query(`DROP OWNED BY "${user}"`);
      await admin.query(`DROP ROLE "${user}"`);
    }
  } finally {
    await admin.end();
  }
});

async function invoke(args: readonly string[], url: URL | null = roleUrl(reader)) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PGOPTIONS: '-c unknown_audit_configuration=bad',
    PGAPPNAME: 'ambient-test',
    PGDATABASE: 'ambient-invalid-db',
    PGUSER: 'ambient-invalid-role',
    PGPASSWORD: 'ambient-test-secret',
  };
  delete env[credential];
  if (url !== null) env[credential] = url.toString();
  const child = Bun.spawn([process.execPath, '--no-env-file', script, ...args], {
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, status] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(stderr).toBe('');
  expect(stdout).not.toContain(password);
  expect(stdout).not.toContain('ambient-test-secret');
  expect(stdout.trim().split('\n')).toHaveLength(1);
  return { status, report: JSON.parse(stdout) as unknown };
}

test('audit command uses explicitly scoped reader credentials and returns a native control report', async () => {
  const observer = new Pool({ connectionString: roleUrl(reader).toString() });
  try {
    const { rows } = await observer.query<{ readable: boolean; writable: boolean }>(
      `SELECT has_table_privilege(current_user, 'economy.position', 'SELECT') AS readable,
              has_table_privilege(current_user, 'economy.position', 'INSERT,UPDATE,DELETE') AS writable`,
    );
    expect(rows[0]).toEqual({ readable: true, writable: false });
  } finally {
    await observer.end();
  }
  expect(await invoke(['--book', bookId])).toMatchObject({
    status: 0,
    report: {
      kind: 'consistent',
      bookId,
      findingCount: 0,
      assets: [
        {
          assetId,
          journalNet: '0',
          components: expect.arrayContaining([
            expect.objectContaining({ role: 'wallet', posted: { projected: '71', reconstructed: '71' } }),
          ]),
        },
      ],
    },
  });
});

test('audit command distinguishes absent, partial and divergent database results', async () => {
  const absent = `cli:absent:${tag}`;
  const missing = await invoke(['--book', absent]);
  expect(missing).toMatchObject({ status: 3, report: { kind: 'absent', bookId: absent } });
  expect(missing.report).not.toHaveProperty('assets');
  const limited = await invoke(['--book', bookId, '--page-limit', '1', '--timeout-ms', '3000']);
  expect(limited).toMatchObject({ status: 4, report: { kind: 'incomplete', bookId, pages: 1 } });
  expect(limited.report).not.toHaveProperty('assets');
  expect(await invoke(['--book', damagedBook])).toMatchObject({
    status: 5,
    report: {
      kind: 'divergent',
      bookId: damagedBook,
      findings: [{ check: 'position_posted', expected: '71', observed: '72' }],
    },
  });
});

test('audit command refuses ambient credentials, arbitrary flags and database URL overrides', async () => {
  const invalid = { status: 2, report: { kind: 'invalid' } };
  expect(await invoke(['--book', bookId], null)).toMatchObject(invalid);
  expect(await invoke(['--book', bookId, '--sql', 'SELECT 1'])).toMatchObject(invalid);
  expect(await invoke(['--book', bookId, '--database-url', roleUrl(reader).toString()])).toMatchObject(invalid);
  expect(await invoke(['--book', bookId, '--page-limit', '2049'])).toMatchObject(invalid);
  expect(await invoke(['--book', bookId, '--timeout-ms', '10001'])).toMatchObject(invalid);
  expect(await invoke(['--book', bookId, '--book', bookId])).toMatchObject(invalid);
  const overridden = roleUrl(reader);
  overridden.searchParams.set('dbname', 'another-db');
  expect(await invoke(['--book', bookId], overridden)).toMatchObject(invalid);
  const ambientPassword = roleUrl(reader);
  ambientPassword.password = '';
  expect(await invoke(['--book', bookId], ambientPassword)).toMatchObject(invalid);
});

test('audit command reports unavailable without runner details under insufficient grants', async () => {
  expect(await invoke(['--book', bookId], roleUrl(denied))).toMatchObject({
    status: 6,
    report: { kind: 'unavailable', bookId },
  });
});
