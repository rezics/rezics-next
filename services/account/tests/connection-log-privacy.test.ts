import { expect, spyOn, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { Pool } from 'pg';
import { logLineCarriesPersonalData } from '@rezics/observability/log';
import { createAccountApp } from '../src/app.ts';

const email = 'reader@example.com';
const agent = 'https://rezics.com/id/00000000-0000-4000-8000-0000000000aa';
const sql = `Key (agent)=(${agent})`;

class DatabaseError extends Error {
  readonly detail = `${sql} VALUES ('private-row')`;
  constructor(readonly code: string) { super(`connection failed for ${email} ${agent}`); }
}

// Building the app installs its listeners; these tests never open a database socket.
const auth = { options: { baseURL: 'https://accounts.example.test', secret: 'test-secret' } } as
  Parameters<typeof createAccountApp>[0];

async function capture(write: () => void | Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const previous = { error: console.error, warn: console.warn, info: console.info };
  const take = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  console.error = take;
  console.warn = take;
  console.info = take;
  try { await write(); }
  finally { Object.assign(console, previous); }
  return lines;
}

function expectPrivateDataAbsent(lines: string[]) {
  for (const line of lines) {
    expect(logLineCarriesPersonalData(line)).toBe(false);
    for (const value of [email, agent, sql, 'private-row', 'connection failed for']) {
      expect(line).not.toContain(value);
    }
  }
}

function expectFault(line: string, connection: 'idle' | 'active', code: string) {
  expect(JSON.parse(line)).toMatchObject({
    level: 'error', event: 'worker_fault',
    'rezics.worker.name': `account.database.${connection}_connection`,
    'error.class': 'DatabaseError', 'error.code': code,
  });
}

test('Account idle pool errors retain safe driver codes without messages or details', async () => {
  const pool = new Pool();
  try {
    createAccountApp(auth, pool);
    const lines = await capture(() => { pool.emit('error', new DatabaseError('57P01')); });
    expect(lines).toHaveLength(1);
    expectFault(lines[0]!, 'idle', '57P01');
    expectPrivateDataAbsent(lines);
  } finally { await pool.end(); }
});

test('Account active client listener survives repeated acquisitions and connection faults', async () => {
  const pool = new Pool();
  try {
    createAccountApp(auth, pool);
    const client = new EventEmitter();
    pool.emit('acquire', client);
    pool.emit('acquire', client);
    expect(client.listenerCount('error')).toBe(1);
    const lines = await capture(() => {
      client.emit('error', new DatabaseError('ECONNRESET'));
      client.emit('error', new DatabaseError('57P01'));
    });
    expect(lines).toHaveLength(2);
    expectFault(lines[0]!, 'active', 'ECONNRESET');
    expectFault(lines[1]!, 'active', '57P01');
    expectPrivateDataAbsent(lines);
  } finally { await pool.end(); }
});

test('Account idle forwarding emits once and the retained listener handles the next checkout', async () => {
  const pool = new Pool();
  try {
    createAccountApp(auth, pool);
    const client = new EventEmitter();
    pool.emit('acquire', client);
    const forwardIdleError = (error: Error) => { pool.emit('error', error, client); };
    client.on('error', forwardIdleError);
    const lines = await capture(() => {
      client.emit('error', new DatabaseError('57P01'));
      client.removeListener('error', forwardIdleError);
      pool.emit('acquire', client);
      client.emit('error', new DatabaseError('ECONNRESET'));
    });
    expect(client.listenerCount('error')).toBe(1);
    expect(lines).toHaveLength(2);
    expectFault(lines[0]!, 'idle', '57P01');
    expectFault(lines[1]!, 'active', 'ECONNRESET');
    expectPrivateDataAbsent(lines);
  } finally { await pool.end(); }
});

test('Account lazy exchange guard pool has the same private idle and active fault listeners', async () => {
  const pool = new Pool();
  const on = Pool.prototype.on;
  let guardPool: Pool | undefined;
  const observe = spyOn(Pool.prototype, 'on').mockImplementation(function (this: Pool, event, listener) {
    if (event === 'acquire' && this !== pool) guardPool = this;
    return on.call(this, event, listener);
  });
  try {
    const app = createAccountApp(auth, pool);
    // Invalid input still creates the guard pool, then returns before connecting.
    const response = await app.handle(new Request('https://accounts.example.test/api/auth/oauth2/token', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=authorization_code',
    }));
    expect(response.status).toBe(400);
    expect(guardPool).toBeDefined();
    const client = new EventEmitter();
    const lines = await capture(() => {
      guardPool!.emit('error', new DatabaseError('57P01'));
      guardPool!.emit('acquire', client);
      guardPool!.emit('acquire', client);
      client.emit('error', new DatabaseError('ECONNRESET'));
    });
    expect(client.listenerCount('error')).toBe(1);
    expect(lines).toHaveLength(2);
    expectFault(lines[0]!, 'idle', '57P01');
    expectFault(lines[1]!, 'active', 'ECONNRESET');
    expectPrivateDataAbsent(lines);
  } finally {
    observe.mockRestore();
    await Promise.all([pool.end(), guardPool?.end()]);
  }
});
