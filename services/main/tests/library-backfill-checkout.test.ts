import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import type { Pool } from 'pg';
import {
  boundedPool, NestedPoolCheckoutError, nestedPoolCheckoutMode, setNestedPoolCheckoutMode,
} from '../src/infrastructure/pg-pool.ts';
import type { FusekiClient } from '../src/infrastructure/fuseki.ts';
import { prepareLibraryShelves } from '../src/modules/library/backfill.ts';

const root = resolve(import.meta.dir, '../../..');

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('no PostgreSQL test port'));
      server.close(() => resolvePort(address.port));
    });
  });
}

function stopCluster(data: string, state: string, socket: string): void {
  try {
    execFileSync('pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop'], { cwd: state, stdio: 'ignore' });
  } catch { /* the cluster never became ready */ }
  rmSync(state, { recursive: true, force: true });
  rmSync(socket, { recursive: true, force: true });
}

/** A checkout from the context that started the backfill is not nested while the
 * backfill holds its connection. A second checkout inside that scan still is. */
test('the library backfill keeps its checkout off the context that started it', async () => {
  const state = join(root, '.temp', `library-backfill-checkout-${process.pid}`);
  const data = join(state, 'pgdata');
  const socket = join(root, '.temp', `lb-sock-${process.pid}`);
  mkdirSync(state, { recursive: true, mode: 0o700 });
  mkdirSync(socket, { recursive: true, mode: 0o700 });
  execFileSync('initdb', ['-D', data, '-A', 'trust', '--no-instructions', '--no-sync'], { cwd: state });
  const port = await freePort();
  execFileSync('pg_ctl', ['-D', data, '-l', join(state, 'postgres.log'),
    '-o', `-h 127.0.0.1 -p ${port} -k ${socket}`, '-w', 'start'], { cwd: state });
  const content = boundedPool({
    host: '127.0.0.1', port, user: process.env.USER, database: 'postgres', max: 3,
    connectionTimeoutMillis: 5_000,
  });
  const previous = nestedPoolCheckoutMode();
  const holding = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const rowErrors: unknown[] = [];
  let nested: unknown;
  let finished: Promise<'done' | unknown> | undefined;
  // Started from the backfill's context once the scan is inside its held checkout.
  let projection: Promise<void> | undefined;
  const access = { query: async () => ({ rows: [] }) } as unknown as Pool;
  const graph = { query: async () => {
    nested = await content.connect().then(client => {
      client.release();
      return 'connected';
    }, (error: unknown) => error);
    holding.resolve();
    await release.promise;
    return { results: { bindings: [] } };
  } } as unknown as FusekiClient;
  const agent = 'https://rezics.com/id/00000000-0000-4000-8000-000000000001';
  const work = 'https://rezics.com/id/00000000-0000-4000-8000-000000000002';
  try {
    await content.query(`CREATE SCHEMA reader;
      CREATE TABLE reader.library_status (
        agent text NOT NULL, work text NOT NULL,
        changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        title_key text, own_rating integer, last_read_at timestamptz,
        PRIMARY KEY (agent, work))`);
    await content.query(`INSERT INTO reader.library_status (agent, work, title_key) VALUES ($1, $2, '')`,
      [agent, work]);
    setNestedPoolCheckoutMode('throw');
    finished = prepareLibraryShelves(content, access, graph, {
      onRowError: (_row, error) => { rowErrors.push(error); },
    }).then(() => 'done' as const, (error: unknown) => error);
    // The content projection worker is started from this same context after the
    // backfill promise is kicked off. Its later checkout must not inherit the hold.
    projection = (async () => {
      await holding.promise;
      const client = await content.connect();
      try { await client.query('SELECT 1'); }
      finally { client.release(); }
    })();
    const entered = await Promise.race([holding.promise.then(() => 'holding' as const), finished]);
    expect(entered).toBe('holding');
    expect(nested).toBeInstanceOf(NestedPoolCheckoutError);
    const own = await content.connect();
    try { await own.query('SELECT 1'); }
    finally { own.release(); }
    await projection;
    release.resolve();
    expect(await finished).toBe('done');
    expect(rowErrors).toEqual([]);
    const saved = await content.query<{ title_key: string | null }>(
      'SELECT title_key FROM reader.library_status WHERE agent = $1 AND work = $2', [agent, work]);
    expect(saved.rows).toEqual([{ title_key: null }]);
    const probe = await content.connect();
    try {
      const locked = (await probe.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_lock(hashtextextended('library-shelves-602', 0)) AS locked")).rows[0]!.locked;
      expect(locked).toBe(true);
      await probe.query("SELECT pg_advisory_unlock(hashtextextended('library-shelves-602', 0))");
    } finally { probe.release(); }
  } finally {
    release.resolve();
    if (finished) await finished.catch(() => undefined);
    setNestedPoolCheckoutMode(previous);
    await content.end();
    stopCluster(data, state, socket);
  }
}, 60_000);
