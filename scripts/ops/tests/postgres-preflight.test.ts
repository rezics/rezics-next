import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import type { Client } from 'pg';
import {
  assertPostgresOwner,
  checkPostgresOwners,
  postgresPreflightConfig,
  POSTGRES_PREFLIGHT_COST,
} from '../postgres-preflight.ts';

function queryRows(rows: unknown[]) {
  return { query: async () => ({ rows }) } as unknown as Pick<Client, 'query'>;
}

for (const owner of ['account', 'access', 'content', 'relay'] as const) {
  const valid = { role: owner, superuser: false, prepared: '0', diagnostics: true };
  test(`${owner} accepts zero prepared transactions with the correct non-superuser owner`, async () => {
    await expect(assertPostgresOwner(queryRows([valid]), owner)).resolves.toBeUndefined();
  });
  test(`${owner} rejects wrong or absent roles and superuser connections`, async () => {
    for (const rows of [[], [valid, valid], [{ ...valid, role: 'postgres' }]])
      await expect(assertPostgresOwner(queryRows(rows), owner)).rejects.toThrow('matching owner');
    for (const superuser of [true, null, undefined])
      await expect(
        assertPostgresOwner(queryRows([{ ...valid, superuser }]), owner),
      ).rejects.toThrow('must not be superuser');
  });
  test(`${owner} refuses nonzero and malformed active settings`, async () => {
    for (const prepared of ['1', '100', '-1', '', null, undefined, 0])
      await expect(assertPostgresOwner(queryRows([{ ...valid, prepared }]), owner)).rejects.toThrow(
        'active max_prepared_transactions=0',
      );
  });
  test(`${owner} requires diagnostics only when its horizon consumer needs them`, async () => {
    for (const diagnostics of [false, null, undefined]) {
      const result = assertPostgresOwner(queryRows([{ ...valid, diagnostics }]), owner);
      if (owner === 'access' || owner === 'content')
        await expect(result).rejects.toThrow('inherited pg_read_all_stats');
      else await expect(result).resolves.toBeUndefined();
    }
  });
}

test('the query is one bounded catalog read and checks immediately usable diagnostic privileges', async () => {
  let sql = '';
  const client = {
    query: async (statement: string) => {
      sql = statement;
      return { rows: [{ role: 'access', superuser: false, prepared: '0', diagnostics: true }] };
    },
  } as unknown as Pick<Client, 'query'>;
  await assertPostgresOwner(client, 'access');
  expect(sql).toContain("pg_has_role(current_user, 'pg_read_all_stats', 'USAGE')");
  expect(sql).toContain('WHERE rolname = current_user');
  expect(sql.trimStart()).toStartWith('SELECT ');
  expect(sql).not.toMatch(/pg_stat_activity|\b(?:GRANT|ALTER|INSERT|UPDATE|DELETE)\b/i);
});

test('connection URL options cannot override the probe bounds or read-only startup', () => {
  const config = postgresPreflightConfig(
    'postgresql://access:private-password@db.internal/access?sslmode=verify-full&options=-c%20role%3Dpostgres&statement_timeout=0&query_timeout=0&lock_timeout=0&connectionTimeoutMillis=0&replication=true&application_name=private-value',
  );
  const parsed = new URL(config.connectionString!);
  expect(parsed.searchParams.get('sslmode')).toBe('verify-full');
  expect([...parsed.searchParams.keys()]).toEqual(['sslmode']);
  expect(config.options).toBe('-c default_transaction_read_only=on');
  expect(config.connectionTimeoutMillis).toBe(POSTGRES_PREFLIGHT_COST.connectionMs);
  expect(config.statement_timeout).toBe(POSTGRES_PREFLIGHT_COST.statementMs);
  expect(config.query_timeout).toBe(POSTGRES_PREFLIGHT_COST.queryMs);
  expect(config.lock_timeout).toBe(POSTGRES_PREFLIGHT_COST.lockMs);
});

test('missing owner configuration refuses before attempting the first connection', async () => {
  await expect(
    checkPostgresOwners({ ACCOUNT_DATABASE_URL: 'malformed-secret-url' }),
  ).rejects.toThrow('requires ACCESS_DATABASE_URL');
});

test('malformed URLs never leak their credentials, input or driver cause', async () => {
  for (const url of [
    'postgres://secret-user:secret-password@[bad',
    'https://secret-user:secret-password@private-host/account',
  ]) {
    const env = Object.fromEntries(
      [
        'ACCOUNT_DATABASE_URL',
        'ACCESS_DATABASE_URL',
        'CONTENT_DATABASE_URL',
        'MAIN_RELAY_DATABASE_URL',
      ].map((name) => [name, url]),
    );
    try {
      await checkPostgresOwners(env);
      throw new Error('Expected refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe(
        'PostgreSQL preflight (account): connection or diagnostic query failed',
      );
      expect((error as Error).cause).toBeUndefined();
      expect((error as Error).stack).not.toMatch(/secret-user|secret-password|private-host/);
    }
  }
});

test('provisioning contains exactly the minimal bounded grant and cluster setting', () => {
  const sql = readFileSync(
    new URL('../../../infra/release/postgres-provision.sql', import.meta.url),
    'utf8',
  );
  const statements = sql
    .replace(/--[^\n]*/g, '')
    .split(';')
    .map((value) => value.trim())
    .filter(Boolean);
  expect(statements).toEqual([
    "SET statement_timeout = '5s'",
    "SET lock_timeout = '5s'",
    'GRANT pg_read_all_stats TO access, content WITH INHERIT TRUE',
    "ALTER SYSTEM SET max_prepared_transactions = '0'",
  ]);
});
