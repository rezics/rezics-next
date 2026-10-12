import { afterAll, beforeAll, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, rmSync } from 'node:fs';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { join, resolve } from 'node:path';
import { Pool, type PoolClient } from 'pg';
import { CommandOutcomeUnknown, FusekiClient, FusekiHttpError, type CommandEnvelope,
  type CommandResult, type SparqlResult } from '../src/infrastructure/fuseki.ts';
import { isOwnerTransientFailure } from '../src/infrastructure/owner-failure.ts';

const root = resolve(import.meta.dir, '../../..');
const stateDirectory = join(root, '.temp', `owner-failure-real-producers-${Bun.randomUUIDv7()}`);
const dataDirectory = join(stateDirectory, 'data');
type DatabaseConnection = { host: string; port: number; user: string; database: string };
let connection: DatabaseConnection | undefined;
let postgresStarted = false;

function deferred<T = void>() {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(resolve => { resolvePromise = resolve; });
  return { promise, resolve: resolvePromise };
}

async function failureFrom(promise: Promise<unknown>): Promise<unknown> {
  try { await promise; }
  catch (error) { return error; }
  throw new Error('the real error producer unexpectedly completed');
}

async function listen(server: HttpServer): Promise<number> {
  return new Promise((resolvePort, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('no local test port'));
      resolvePort(address.port);
    });
  });
}

async function close(server: HttpServer): Promise<void> {
  await new Promise<void>((resolveClose, reject) => {
    server.close(error => error ? reject(error) : resolveClose());
  });
}

async function closedLocalPort(): Promise<number> {
  const server = createTcpServer();
  return new Promise((resolvePort, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('no closed test port'));
      const port = address.port;
      server.close(error => error ? reject(error) : resolvePort(port));
    });
  });
}

beforeAll(async () => {
  mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
  execFileSync('initdb', ['-D', dataDirectory, '-A', 'trust', '--no-instructions'], {
    cwd: stateDirectory, timeout: 30_000,
  });
  appendFileSync(join(dataDirectory, 'postgresql.conf'), "\nunix_socket_directories = ''\n");
  const port = await closedLocalPort();
  execFileSync('pg_ctl', ['-D', dataDirectory, '-l', join(stateDirectory, 'postgres.log'),
    '-o', `-h 127.0.0.1 -p ${port}`, '-w', 'start'], {
    cwd: stateDirectory, timeout: 30_000,
  });
  postgresStarted = true;
  connection = { host: '127.0.0.1', port,
    user: process.env.USER ?? process.env.USERNAME ?? 'edge', database: 'postgres' };
  const pool = new Pool({ ...connection, max: 1, connectionTimeoutMillis: 2_000 });
  try { await pool.query('SELECT 1'); }
  finally { await pool.end(); }
}, 60_000);

afterAll(async () => {
  if (postgresStarted) execFileSync('pg_ctl', ['-D', dataDirectory, '-m', 'fast', '-w', 'stop'], {
    cwd: stateDirectory, timeout: 30_000,
  });
  rmSync(stateDirectory, { recursive: true, force: true });
}, 60_000);

test('native fetch deadline produces a TimeoutError and is transient', async () => {
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0,
    fetch: () => new Promise<Response>(() => {}) });
  try {
    const pending = fetch(server.url, { signal: AbortSignal.timeout(1) });
    const failure = await failureFrom(pending);
    expect(failure).toBeInstanceOf(DOMException);
    expect(failure).toMatchObject({ name: 'TimeoutError' });
    expect(isOwnerTransientFailure(failure)).toBe(true);
  } finally { await server.stop(true); }
}, 5_000);

test('native fetch to a closed local port preserves ECONNREFUSED and is transient', async () => {
  const port = await closedLocalPort();
  const failure = await failureFrom(fetch(`http://127.0.0.1:${port}/closed`));
  expect(failure).toBeInstanceOf(TypeError);
  const nativeFailure = failure as Error & { code?: string; cause?: { code?: string } };
  expect(nativeFailure.message).toMatch(/fetch failed|ECONNREFUSED/);
  expect(nativeFailure.code ?? nativeFailure.cause?.code).toBe('ECONNREFUSED');
  expect(isOwnerTransientFailure(failure)).toBe(true);
});

test('native fetch after a local server destroys its response socket is transient', async () => {
  const server = createHttpServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json', 'content-length': '64' });
    response.flushHeaders();
    response.write('{"partial":');
    setTimeout(() => response.socket?.destroy(), 10);
  });
  const port = await listen(server);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/partial`);
    const failure = await failureFrom(response.text());
    expect(failure).toBeInstanceOf(TypeError);
    expect(isOwnerTransientFailure(failure)).toBe(true);
  } finally { await close(server); }
});

test('a real FusekiClient retains structured 503 status as transient transport evidence', async () => {
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0,
    fetch: () => new Response('temporarily unavailable', { status: 503 }) });
  try {
    const failure = await failureFrom(new FusekiClient(`${server.url.href}rezics/`).query('ASK {}'));
    expect(failure).toBeInstanceOf(FusekiHttpError);
    expect(failure).toMatchObject({ status: 503, message: 'Fuseki query returned 503' });
    expect(isOwnerTransientFailure(failure)).toBe(true);
  } finally { await server.stop(true); }
});

test('a real FusekiClient keeps a structured 400 response non-transient', async () => {
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0,
    fetch: () => new Response('bad request', { status: 400 }) });
  try {
    const failure = await failureFrom(new FusekiClient(`${server.url.href}rezics/`).query('ASK {}'));
    expect(failure).toBeInstanceOf(FusekiHttpError);
    expect(failure).toMatchObject({ status: 400, message: 'Fuseki query returned 400' });
    expect(isOwnerTransientFailure(failure)).toBe(false);
  } finally { await server.stop(true); }
});

test('a real FusekiClient keeps HTTP 500 as structured transient transport evidence', async () => {
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0,
    fetch: () => new Response('temporarily unavailable', { status: 500 }) });
  try {
    const failure = await failureFrom(new FusekiClient(`${server.url.href}rezics/`).query('ASK {}'));
    expect(failure).toBeInstanceOf(FusekiHttpError);
    expect(failure).toMatchObject({ status: 500, message: 'Fuseki query returned 500' });
    expect(isOwnerTransientFailure(failure)).toBe(true);
  } finally { await server.stop(true); }
});

test('a real FusekiClient preserves CommandOutcomeUnknown through an absent receipt lookup', async () => {
  const timeout = new Error('command request timed out');
  const commandFailure = new CommandOutcomeUnknown('Fuseki command transport outcome unknown', { cause: timeout });
  class ReceiptLookupFuseki extends FusekiClient {
    receiptQueries = 0;
    override async command(_envelope: CommandEnvelope): Promise<CommandResult> { throw commandFailure; }
    override async query(_sparql: string): Promise<SparqlResult> {
      this.receiptQueries++;
      return { results: { bindings: [] } };
    }
  }
  const client = new ReceiptLookupFuseki('http://localhost:1/rezics');
  const envelope: CommandEnvelope = { receipt: 'urn:rezics:receipt:owner-failure-timeout',
    digest: 'a'.repeat(64), update: 'INSERT DATA {}', validations: [], deadlineMs: 1_000 };
  const failure = await failureFrom(client.commandWithReceipt(envelope));
  expect(failure).toBeInstanceOf(CommandOutcomeUnknown);
  expect((failure as Error).cause).toBe(commandFailure);
  expect(commandFailure.cause).toBe(timeout);
  expect(client.receiptQueries).toBe(1);
  expect(isOwnerTransientFailure(failure)).toBe(true);
});

test('a real pg Pool observes PostgreSQL terminating an idle-in-transaction backend as transient', async () => {
  const clientPool = new Pool({ ...connection!, max: 1, connectionTimeoutMillis: 2_000 });
  const administrator = new Pool({ ...connection!, max: 1, connectionTimeoutMillis: 2_000 });
  let client: PoolClient | undefined;
  try {
    client = await clientPool.connect();
    const backendFailure = new Promise<Error>(resolveError => client!.once('error', resolveError));
    await client.query('BEGIN');
    const backend = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    const pid = backend.rows[0]!.pid;
    const state = await administrator.query<{ state: string }>(
      'SELECT state FROM pg_stat_activity WHERE pid = $1', [pid]);
    expect(state.rows[0]?.state).toBe('idle in transaction');
    const terminated = await administrator.query<{ terminated: boolean }>(
      'SELECT pg_terminate_backend($1) AS terminated', [pid]);
    expect(terminated.rows[0]?.terminated).toBe(true);
    const failure = await backendFailure;
    expect((failure as Error & { code?: string }).code === '57P01'
      || failure.message === 'Connection terminated unexpectedly').toBe(true);
    expect(isOwnerTransientFailure(failure)).toBe(true);
  } finally {
    client?.release(true);
    await Promise.all([clientPool.end(), administrator.end()]);
  }
}, 10_000);

test('a caller AbortError stays non-transient when no deadline appears in its cause chain', async () => {
  const reached = deferred();
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => {
    reached.resolve();
    return new Promise<Response>(() => {});
  } });
  const controller = new AbortController();
  try {
    const pending = fetch(server.url, { signal: controller.signal });
    const failurePromise = failureFrom(pending);
    await reached.promise;
    controller.abort();
    const failure = await failurePromise;
    expect(failure).toMatchObject({ name: 'AbortError' });
    expect(isOwnerTransientFailure(failure)).toBe(false);
  } finally { await server.stop(true); }
}, 5_000);

test('plain errors and a real PostgreSQL unique violation stay non-transient', async () => {
  expect(isOwnerTransientFailure(new Error('boom'))).toBe(false);
  const pool = new Pool({ ...connection!, max: 1, connectionTimeoutMillis: 2_000 });
  const client = await pool.connect();
  try {
    await client.query('CREATE TEMP TABLE owner_failure_integrity_probe (id integer PRIMARY KEY)');
    await client.query('INSERT INTO owner_failure_integrity_probe (id) VALUES (1)');
    const failure = await failureFrom(client.query('INSERT INTO owner_failure_integrity_probe (id) VALUES (1)'));
    expect((failure as Error & { code?: string }).code).toBe('23505');
    expect(isOwnerTransientFailure(failure)).toBe(false);
  } finally {
    client.release();
    await pool.end();
  }
}, 10_000);
