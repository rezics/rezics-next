import { expect, spyOn, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { Pool, type PoolClient } from 'pg';
import { logLineCarriesPersonalData } from '@rezics/observability/log';
import {
  boundedPool, nestedPoolCheckoutMode, setNestedPoolCheckoutMode,
} from '../src/infrastructure/pg-pool.ts';
import { migrateGraphAliases } from '../src/modules/address/migrate.ts';
import type { WorkActivationEnvironment } from '../src/modules/work/activate.ts';

const email = 'reader@example.com';
const agent = 'https://rezics.com/id/00000000-0000-4000-8000-0000000000aa';
const sql = `Key (agent)=(${agent})`;

class DatabaseError extends Error {
  constructor(readonly code: string) {
    super(`database failure for ${email} ${agent} VALUES ('private-value')`);
  }
  readonly detail = sql;
  readonly query = `SELECT agent FROM reader.library_status WHERE email = '${email}'`;
}

async function capture(write: () => void | Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const take = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  const spies = [spyOn(console, 'error'), spyOn(console, 'warn'), spyOn(console, 'info')];
  for (const spy of spies) spy.mockImplementation(take);
  try { await write(); }
  finally { for (const spy of spies) spy.mockRestore(); }
  return lines;
}

function expectFault(line: string | undefined, worker: string, code?: string) {
  expect(line).toBeDefined();
  expect(JSON.parse(line!)).toEqual({
    level: 'error', event: 'worker_fault', 'rezics.worker.name': worker,
    'error.class': code ? 'DatabaseError' : 'NestedPoolCheckoutError',
    ...(code ? { 'error.code': code } : {}),
  });
  expect(logLineCarriesPersonalData(line!)).toBe(false);
  for (const privateValue of [email, agent, sql, 'private-value', 'private-title', 'database failure']) {
    expect(line).not.toContain(privateValue);
  }
}

test('pool and checked-out client error listeners retain bounded database diagnostics', async () => {
  const pool = boundedPool({ allowExitOnIdle: true });
  const connection = new EventEmitter();
  const client = Object.assign(new EventEmitter(), { connection }) as unknown as PoolClient;
  try {
    const lines = await capture(() => {
      expect(pool.emit('error', new DatabaseError('08006'))).toBe(true);
      pool.emit('connect', client);
      expect(connection.listenerCount('errorMessage')).toBe(1);
      expect(client.listenerCount('error')).toBe(1);
      expect(client.emit('error', new DatabaseError('25P03'))).toBe(true);
      expect(client.emit('error', new DatabaseError('57P01'))).toBe(true);
      expect(client.listenerCount('error')).toBe(1);
    });
    expect(lines).toHaveLength(3);
    for (const [index, code] of ['08006', '25P03', '57P01'].entries()) {
      expectFault(lines[index], 'main.database.connection', code);
    }
  } finally { await pool.end(); }
});

test('nested checkout diagnostics use the fixed fault event and preserve log-mode checkout', async () => {
  const client = { release: () => {} } as unknown as PoolClient;
  const connect = spyOn(Pool.prototype, 'connect').mockImplementation(
    (() => Promise.resolve(client)) as Pool['connect'],
  );
  const previousMode = nestedPoolCheckoutMode();
  const pool = boundedPool({ allowExitOnIdle: true });
  setNestedPoolCheckoutMode('log');
  try {
    const lines = await capture(async () => {
      const held = await pool.connect();
      const nested = await pool.connect();
      expect(nested).toBe(client);
      held.release();
    });
    expect(lines).toHaveLength(1);
    const line = lines[0]!;
    const reported = JSON.parse(line) as Record<string, unknown>;
    expect(reported).toMatchObject({
      level: 'error', event: 'worker_fault', 'rezics.worker.name': 'main.database.nested-checkout',
      'error.class': 'NestedPoolCheckoutError',
    });
    expect(String(reported['rezics.checkout.inner'])).toContain('database-log-privacy.test.ts:');
    expect(String((reported['rezics.checkout.outer'] as string[])[0])).toContain('database-log-privacy.test.ts:');
    expect(logLineCarriesPersonalData(line)).toBe(false);
    for (const privateValue of [email, agent, sql, 'private-value', 'private-title', 'database failure']) {
      expect(line).not.toContain(privateValue);
    }
  } finally {
    connect.mockRestore();
    setNestedPoolCheckoutMode(previousMode);
    await pool.end();
  }
});

test('a deferred alias import retains its database code and completes on retry without logging private data', async () => {
  let failed = true;
  const env = {
    addresses: { pool: { query: async (statement: string) => {
      if (failed) throw new DatabaseError('08006');
      if (statement.includes('SELECT cursor,completed_at')) return { rows: [{ completed_at: new Date() }] };
      if (statement.includes('recovery_fence')) return { rowCount: 1 };
      if (statement.includes('SELECT source,legacy_alias')) return { rows: [] };
      throw new Error('Unexpected import query');
    } } },
    lineage: { dataEpoch: 'epoch' },
    fuseki: { query: async () => ({ boolean: false }) },
  } as unknown as WorkActivationEnvironment;
  const lines = await capture(async () => {
    expect(await migrateGraphAliases(env)).toEqual({ status: 'deferred' });
    failed = false;
    expect(await migrateGraphAliases(env)).toEqual({ status: 'complete' });
  });
  expect(lines).toHaveLength(1);
  expectFault(lines[0], 'main.address.alias-import', '08006');
});

for (const code of ['23505', '23514']) {
  test(`a skipped alias with database code ${code} keeps private repair evidence out of logs`, async () => {
    const binding = (value: string) => ({ type: 'literal', value });
    const row = {
      source: binding(agent), scope: binding('work'), kind: binding('work'),
      holder: binding(agent), controller: binding(agent), state: binding('current'),
      key: binding('private-title'),
    };
    const failure = new DatabaseError(code);
    const statements: string[] = [];
    const reports: unknown[][] = [];
    let released = false;
    const env = {
      addresses: {
        assertAliasAllowed: async () => { throw failure; },
        pool: {
          query: async (statement: string, args: string[]) => {
            if (statement.includes('SELECT cursor,completed_at')) return { rows: [{ completed_at: new Date() }] };
            if (statement.includes('recovery_fence')) return { rowCount: 1 };
            if (statement.includes('SELECT source,legacy_alias')) return {
              rows: args[1] === '' ? [{ source: agent, legacy_alias: row }] : [],
            };
            throw new Error('Unexpected import query');
          },
          connect: async () => ({
            query: async (statement: string, args?: unknown[]) => {
              statements.push(statement);
              if (statement.includes('INSERT INTO access.alias_graph_import_report')) reports.push(args!);
              return { rowCount: 1 };
            },
            release: () => { released = true; },
          }),
        },
      },
      lineage: { dataEpoch: 'epoch' },
      fuseki: { query: async () => ({ boolean: false }) },
    } as unknown as WorkActivationEnvironment;
    const lines = await capture(async () => {
      expect(await migrateGraphAliases(env)).toEqual({ status: 'complete' });
    });
    expect(lines).toHaveLength(1);
    expectFault(lines[0], 'main.address.alias-import.skip', code);
    expect(statements).toContain('ROLLBACK TO SAVEPOINT import_name');
    expect(statements).toContain('COMMIT');
    expect(released).toBe(true);
    expect(reports).toEqual([['epoch', agent, failure.message, JSON.stringify(row)]]);
  });
}
