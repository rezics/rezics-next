import { expect, test } from 'bun:test';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Client } from 'pg';
import { startPostgresCluster } from '../../tests/qa/support/postgres-cluster.ts';
import { ensurePostgresSocketDirectory, physicalPath, POSTGRES_SOCKET_LIMIT, postgresSocketByteLength,
  postgresSocketDirectory, postgresSocketPath, postgresSocketRefusal, releasePostgresSocketDirectory } from './postgres-socket.ts';

function deepCheckout() {
  const parent = mkdtempSync(resolve(import.meta.dir, '../../.temp/socket-test-'));
  const checkout = join(parent, 'nested'.repeat(30), '.temp/tmp/goalctl-unlanded-random/.temp/worktrees/g-1000');
  mkdirSync(checkout, { recursive: true });
  return { parent, checkout };
}

test('short checkouts keep their owned socket directory', () => {
  expect(postgresSocketPath('/tmp/short-checkout')).toBe('/tmp/short-checkout/.temp/pg-sock/.s.PGSQL.65535');
  expect(postgresSocketRefusal('/tmp/short-checkout')).toBeUndefined();
});

test('arbitrarily deep and multibyte checkouts get stable distinct short aliases', () => {
  const checkout = resolve('.temp', '深'.repeat(200));
  expect(postgresSocketByteLength(checkout)).toBeLessThanOrEqual(POSTGRES_SOCKET_LIMIT);
  expect(postgresSocketDirectory(checkout)).toBe(postgresSocketDirectory(join(checkout, 'child', '..')));
  expect(postgresSocketDirectory(checkout)).not.toBe(postgresSocketDirectory(checkout + 'x'));
  expect(postgresSocketRefusal(checkout)).toBeUndefined();
});

test('even an unusable alias root retains the byte-length refusal', () => {
  const checkout = resolve('.temp', 'deep'.repeat(60));
  const root = resolve('.temp', 'long'.repeat(60));
  const path = postgresSocketPath(checkout, root);
  expect(postgresSocketRefusal(checkout, root)).toBe(
    `runner configuration: PostgreSQL socket path is ${Buffer.byteLength(path)} bytes, above the 107-byte limit: ${path}`);
  expect(() => ensurePostgresSocketDirectory(checkout, root)).toThrow('PostgreSQL socket path is');
});

test('deep sockets live inside their worktree and unused aliases are cleaned up', () => {
  const fixture = deepCheckout();
  const directory = ensurePostgresSocketDirectory(fixture.checkout);
  try {
    expect(ensurePostgresSocketDirectory(fixture.checkout)).toBe(directory);
    expect(physicalPath(directory)).toBe(join(fixture.checkout, '.temp/pg-sock/65535'));
    const socket = join(directory, '.s.PGSQL.65535');
    writeFileSync(socket, 'active socket');
    releasePostgresSocketDirectory(fixture.checkout);
    expect(existsSync(socket)).toBe(true);
    rmSync(fixture.checkout, { recursive: true });
    expect(existsSync(socket)).toBe(false);
    releasePostgresSocketDirectory(fixture.checkout);
    expect(() => lstatSync(directory)).toThrow();
  } finally { rmSync(fixture.parent, { recursive: true, force: true }); releasePostgresSocketDirectory(fixture.checkout); }
});

test('cluster startup uses the selected short socket and shutdown removes its alias', async () => {
  const checkout = resolve(import.meta.dir, '../..');
  const cluster = await startPostgresCluster();
  const directory = postgresSocketDirectory(checkout, '/tmp', cluster.port);
  const socket = join(directory, `.s.PGSQL.${cluster.port}`);
  const client = new Client({ ...cluster.connection, host: directory });
  try {
    expect(existsSync(socket)).toBe(true);
    await client.connect();
    expect((await client.query('SELECT 1 AS n')).rows[0].n).toBe(1);
  } finally { await client.end(); cluster.remove(); }
  expect(existsSync(socket)).toBe(false);
  if (directory.startsWith('/tmp/rezics-pg-') && !readdirSync(join(checkout, `.temp/pg-sock/${cluster.port}`)).length)
    expect(() => lstatSync(directory)).toThrow();
}, 30_000);

test('one cluster cannot remove a neighbouring cluster socket alias during startup', () => {
  const fixture = deepCheckout();
  const first = ensurePostgresSocketDirectory(fixture.checkout, '/tmp', 10001);
  const second = ensurePostgresSocketDirectory(fixture.checkout, '/tmp', 10002);
  try {
    expect(first).not.toBe(second);
    releasePostgresSocketDirectory(fixture.checkout, '/tmp', 10001);
    expect(() => lstatSync(first)).toThrow();
    expect(existsSync(second)).toBe(true);
    writeFileSync(join(second, '.s.PGSQL.10002'), 'neighbour socket');
    expect(existsSync(join(fixture.checkout, '.temp/pg-sock/10002/.s.PGSQL.10002'))).toBe(true);
  } finally {
    rmSync(fixture.parent, { recursive: true, force: true });
    releasePostgresSocketDirectory(fixture.checkout, '/tmp', 10001);
    releasePostgresSocketDirectory(fixture.checkout, '/tmp', 10002);
  }
});
