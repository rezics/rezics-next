import { afterEach, beforeEach, expect, test } from 'bun:test';
import pg, { type PoolClient, type QueryResult } from 'pg';
import outboxFence from '../../../src/command/fence.sql';
import { observeSql, type SqlObserver } from './sql-observer.ts';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL must name the migrated test database');
let pool: pg.Pool;
let observer: SqlObserver | undefined;
let table: string;
let wire: string[];
const clients: PoolClient[] = [];

beforeEach(async () => {
  pool = new pg.Pool({ connectionString: url, max: 3 });
  wire = [];
  pool.on('connect', (client) => {
    // Count actual protocol submissions, including any SQL the observer might add.
    const connection = client.connection;
    const query = connection.query;
    const parse = connection.parse;
    connection.query = function (text) {
      wire.push(text);
      return query.call(this, text);
    };
    connection.parse = function (config, more) {
      wire.push(config.text);
      return parse.call(this, config, more);
    };
  });
  expect((await pool.query("SELECT to_regclass('content.thread') AS migrated")).rows[0].migrated).toBe(
    'content.thread',
  );
  table = `sql_observer_${Bun.randomUUIDv7().replaceAll('-', '')}`;
  await pool.query(`CREATE TABLE ${table} (id integer PRIMARY KEY, value text)`);
  wire.length = 0;
});

afterEach(async () => {
  await observer?.close();
  observer = undefined;
  for (const client of clients.splice(0)) {
    await client.query('ROLLBACK');
    client.release();
  }
  await pool.query(`DROP TABLE ${table}`);
  await pool.end();
});

async function connect() {
  const client = await pool.connect();
  clients.push(client);
  return client;
}

function start() {
  observer = observeSql(pool);
  return observer;
}

async function ids() {
  return (await pool.query(`SELECT id FROM ${table} ORDER BY id`)).rows.map((row) => row.id);
}

const insert = () => `INSERT INTO ${table} VALUES ($1, $2) RETURNING id`;

test('captures real pool, existing client and parameterized Reylo queries once without adding SQL', async () => {
  const client = await connect();
  const pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  const other = await connect();
  const otherPid = (await other.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  const { default: read } = await import('../../../src/content/read-revision.sql');
  const params = {
    route: 1,
    thread_id: Bun.randomUUIDv7(),
    post_id: Bun.randomUUIDv7(),
    revision_id: Bun.randomUUIDv7(),
  };
  expect(await read.run(other, params)).toEqual([]);
  wire.length = 0;
  const trace = start();
  const values = [
    "quote '$1' \\ bytes",
    null,
    Buffer.from([0, 255]),
    new Date('2026-01-02T03:04:05Z'),
    [2, 3],
    { a: 7 },
  ];
  const text = 'SELECT $1::text, $2::text, $3::bytea, $4::timestamptz, $5::int[], $6::jsonb';
  const native = await client.query({ text, values, rowMode: 'array' });
  expect(await read.run(other, params)).toEqual([]);
  expect(native.rows[0]).toEqual(values);
  await pool.query('SELECT 42 AS answer');
  expect(trace.records.map((record) => record.statement)).toEqual([text, read.sql, 'SELECT 42 AS answer']);
  expect(wire).toEqual([text, read.sql, 'SELECT 42 AS answer']);
  expect(trace.records[0]).toMatchObject({ parameters: values, connectionId: pid });
  expect(trace.records[1]).toMatchObject({
    parameters: read.params.map((key) => params[key as keyof typeof params]),
    connectionId: otherPid,
  });
  expect(otherPid).not.toBe(pid);
  for (const record of trace.records) {
    expect(record.connectionId).toBeGreaterThan(0);
    expect(Number.isNaN(Date.parse(record.executedAt))).toBe(false);
  }
  (values[2] as Buffer)[0] = 99;
  (values[4] as number[]).push(4);
  (values[5] as { a: number }).a = 8;
  expect(trace.records[0]!.parameters.slice(2)).toEqual([
    Buffer.from([0, 255]),
    new Date('2026-01-02T03:04:05Z'),
    [2, 3],
    { a: 7 },
  ]);
});

test('preserves promise, callback and config overloads and native result/error identity', async () => {
  const client = await connect();
  const original = client.query;
  let nativeResult!: QueryResult;
  let nativeError!: Error;
  client.query = ((...args: any[]) => {
    const callback = args.at(-1);
    if (typeof callback !== 'function') return Reflect.apply(original, client, args);
    args[args.length - 1] = (error: Error, result: QueryResult) => {
      nativeResult = result;
      nativeError = error;
      callback(error, result);
    };
    return Reflect.apply(original, client, args);
  }) as typeof original;
  start();
  const promised = client.query('SELECT $1::int AS answer', [7]);
  expect(promised).toBeInstanceOf(Promise);
  expect(await promised).toBe(nativeResult);
  for (const config of [
    'SELECT 8 AS answer',
    { text: 'SELECT $1::int AS answer', values: [8], rowMode: 'array' as const },
  ]) {
    await new Promise<void>((resolve, reject) => {
      const returned = client.query(config, (error, result) => {
        if (error) return reject(error);
        expect(result).toBe(nativeResult);
        resolve();
      });
      expect(returned).toBeUndefined();
    });
  }
  await new Promise<void>((resolve, reject) => {
    expect(
      client.query('SELECT $1::int', [9], (error, result) => {
        if (error) return reject(error);
        expect(result).toBe(nativeResult);
        resolve();
      }),
    ).toBeUndefined();
  });
  const reusable = { name: 'observer_named', text: 'SELECT $1::int AS answer', values: [12] };
  expect((await client.query(reusable)).rows).toEqual([{ answer: 12 }]);
  reusable.values[0] = 13;
  expect((await client.query(reusable)).rows).toEqual([{ answer: 13 }]);
  expect(reusable).not.toHaveProperty('callback');
  const failure = await client.query('SELECT 1 / 0').catch((error) => error);
  expect(failure).toBe(nativeError);
  expect(failure.code).toBe('22012');
  await new Promise<void>((resolve) => {
    expect(
      pool.query({ text: 'SELECT $1::int', values: ['invalid'] }, (error) => {
        expect(error).toMatchObject({ code: '22P02' });
        resolve();
      }),
    ).toBeUndefined();
  });
});

test('before holds stop real execution, preserve queued order and leave independent clients free', async () => {
  const client = await connect();
  const trace = start();
  const barrier = trace.hold({ statement: insert() }, 'before');
  const first = client.query(insert(), [1, 'first']);
  const second = client.query(`INSERT INTO ${table} VALUES (2, 'second')`);
  const entered = await barrier.entered;
  expect(trace.records).toContain(entered);
  expect(wire).not.toContain(insert());
  expect(await ids()).toEqual([]);
  barrier.release();
  barrier.release();
  await Promise.all([first, second]);
  expect(await ids()).toEqual([1, 2]);
  expect(wire.filter((sql) => sql.startsWith('INSERT'))).toEqual([
    insert(),
    `INSERT INTO ${table} VALUES (2, 'second')`,
  ]);
  await client.query(insert(), [3, 'third']); // The hold is one-shot.
});

test('after holds expose actual committed inserts and transaction controls in observed order', async () => {
  const client = await connect();
  const trace = start();
  const barrier = trace.hold({ statement: insert() }, 'after');
  let returned = false;
  const pending = client.query(insert(), [1, 'committed']).then((result) => {
    returned = true;
    return result;
  });
  await barrier.entered;
  expect(returned).toBe(false);
  expect(await ids()).toEqual([1]);
  barrier.release();
  expect((await pending).rows).toEqual([{ id: 1 }]);
  await client.query('BEGIN');
  await client.query(insert(), [2, 'rolled back']);
  const rollback = trace.hold({ statement: 'ROLLBACK' }, 'after');
  const rollingBack = client.query('ROLLBACK');
  await rollback.entered;
  expect(await ids()).toEqual([1]);
  rollback.release();
  await rollingBack;
  expect(
    trace.records
      .filter((record) => record.statement === 'BEGIN' || record.statement === 'ROLLBACK')
      .map((record) => record.statement),
  ).toEqual(['BEGIN', 'ROLLBACK']);
});

test('exact text and relative occurrences select one-shot before/after faults without undoing effects', async () => {
  const client = await connect();
  const trace = start();
  const before = new Error('before');
  const after = new Error('after');
  await client.query(insert(), [0, 'before arming']);
  trace.armFault({ match: { statement: insert(), occurrence: 2 }, boundary: 'before', error: before });
  await client.query(`${insert()} `, [1, 'different text']);
  await client.query(insert(), [2, 'first match']);
  expect(await client.query(insert(), [3, 'prevented']).catch((error) => error)).toBe(before);
  await client.query(insert(), [4, 'one shot']);
  trace.armFault({ match: { statement: insert() }, boundary: 'after', error: after });
  expect(await client.query(insert(), [5, 'committed']).catch((error) => error)).toBe(after);
  await client.query('BEGIN');
  trace.armFault({ match: { statement: insert() }, boundary: 'after', error: after });
  expect(await client.query(insert(), [6, 'transactional']).catch((error) => error)).toBe(after);
  expect((await client.query(`SELECT id FROM ${table} WHERE id = 6`)).rows).toEqual([{ id: 6 }]);
  expect(await ids()).toEqual([0, 1, 2, 4, 5]);
  await client.query('ROLLBACK');
  trace.armFault({ match: { statement: insert() }, boundary: 'after', error: after });
  const nativeFailure = await client.query(insert(), [5, 'duplicate']).catch((error) => error);
  expect(nativeFailure).toMatchObject({ code: '23505' });
  await client.query(insert(), [7, 'fault consumed by native failure']);
  expect(await ids()).toEqual([0, 1, 2, 4, 5, 7]);
  expect(wire.filter((sql) => sql === insert())).toHaveLength(7);
});

test('faults the observed Reylo outbox fence before protocol submission and rolls back its probe', async () => {
  const client = await connect();
  const pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  const trace = start();
  const event = {
    id: crypto.randomUUID(),
    type: 'sql-observer.test',
    subject: 'sql-observer',
    data: { observed: true },
  };
  const parameters = {
    partition_no: 0,
    events: JSON.stringify([event]),
    transaction_id: crypto.randomUUID(),
    basis: null,
    receipt: null,
  };

  await client.query('BEGIN');
  await outboxFence.run(client, parameters);
  const executed = trace.records.find(
    (record) =>
      record.statement.includes('UPDATE core.partition') && record.statement.includes('INSERT INTO core.outbox'),
  );
  expect(executed).toBeDefined();
  if (!executed) throw new Error('The real outbox fence query was not observed');
  expect(executed.connectionId).toBe(pid);
  expect(executed.parameters).toContain(parameters.events);
  await client.query('ROLLBACK');

  const fault = new Error('stop before outbox submission');
  const nextParameters = { ...parameters, transaction_id: crypto.randomUUID() };
  await client.query('BEGIN');
  trace.armFault({ match: { statement: executed.statement }, boundary: 'before', error: fault });
  const failure = await outboxFence.run(client, nextParameters).catch((error) => error);
  expect(failure).toBe(fault);
  expect(wire.filter((statement) => statement === executed.statement)).toHaveLength(1);
  await client.query('ROLLBACK');
});

test('occurrence holds select invocation order across clients even when completion order differs', async () => {
  const first = await connect();
  const second = await connect();
  const trace = start();
  const before = trace.hold({ statement: insert() }, 'before');
  const after = trace.hold({ statement: insert(), occurrence: 2 }, 'after');
  const blocked = first.query(insert(), [1, 'blocked']);
  await before.entered;
  const independent = second.query(insert(), [2, 'independent']);
  const selected = await after.entered;
  expect(selected.parameters).toEqual([2, 'independent']);
  expect(await ids()).toEqual([2]);
  after.release();
  await independent;
  before.release();
  await blocked;
});

test('close releases entered and pending holds, removes faults and restores the caller pool idempotently', async () => {
  const first = await connect();
  const query = first.query;
  const poolQuery = pool.query;
  const listeners = ['connect', 'acquire', 'remove'].map((event) => pool.listenerCount(event));
  const trace = start();
  const second = await connect();
  const before = trace.hold({ statement: insert() }, 'before');
  const after = trace.hold({ statement: 'SELECT 17' }, 'after');
  const pending = first.query(insert(), [1, 'released']);
  const completed = second.query('SELECT 17');
  await Promise.all([before.entered, after.entered]);
  const unused = trace.hold({ statement: 'SELECT 18' }, 'before');
  trace.armFault({ match: { statement: 'COMMIT' }, boundary: 'before', error: new Error('removed') });
  await trace.close();
  await trace.close();
  before.release();
  after.release();
  unused.release();
  await Promise.all([pending, completed]);
  expect(first.query).toBe(query);
  expect(pool.query).toBe(poolQuery);
  expect(['connect', 'acquire', 'remove'].map((event) => pool.listenerCount(event))).toEqual(listeners);
  const count = trace.records.length;
  await first.query('BEGIN');
  await first.query('COMMIT');
  await second.query('SELECT 18');
  expect(await ids()).toEqual([1]);
  expect(trace.records).toHaveLength(count);
  expect(pool.ending).toBe(false);
});

test('native Query objects retain callback/event delivery and identity across real boundaries', async () => {
  const client = await connect();
  const trace = start();
  const barrier = trace.hold({ statement: insert() }, 'after');
  const query = new pg.Query(insert(), [1, 'native events']);
  let ended = false;
  const ending = new Promise<void>((resolve, reject) => {
    query.once('error', reject);
    query.once('end', (result) => {
      ended = true;
      expect(result.rows).toEqual([{ id: 1 }]);
      resolve();
    });
  });
  expect(client.query(query)).toBe(query);
  await barrier.entered;
  expect(ended).toBe(false);
  expect(await ids()).toEqual([1]);
  barrier.release();
  await ending;
  const fault = new Error('after native Query');
  trace.armFault({ match: { statement: insert() }, boundary: 'after', error: fault });
  await new Promise<void>((resolve) => {
    const callbackQuery = new pg.Query(insert(), [2, 'native callback'], (error) => {
      expect(error).toBe(fault);
      resolve();
    });
    expect(client.query(callbackQuery)).toBe(callbackQuery);
  });
  expect(await ids()).toEqual([1, 2]);
});

test('commit faults preserve the real transaction state before and after execution', async () => {
  const client = await connect();
  const trace = start();
  const fault = new Error('commit fault');
  await client.query('BEGIN');
  await client.query(insert(), [1, 'uncommitted']);
  trace.armFault({ match: { statement: 'COMMIT' }, boundary: 'before', error: fault });
  expect(await client.query('COMMIT').catch((error) => error)).toBe(fault);
  expect(client.getTransactionStatus()).toBe('T');
  expect(await ids()).toEqual([]);
  await client.query('ROLLBACK');
  await client.query('BEGIN');
  await client.query(insert(), [2, 'committed']);
  trace.armFault({ match: { statement: 'COMMIT' }, boundary: 'after', error: fault });
  expect(await client.query('COMMIT').catch((error) => error)).toBe(fault);
  expect(client.getTransactionStatus()).toBe('I');
  expect(await ids()).toEqual([2]);
});

test('early release is idempotent and close preserves an open transaction on restored clients', async () => {
  const client = await connect();
  const original = client.query;
  const trace = start();
  const barrier = trace.hold({ statement: insert() }, 'before');
  barrier.release();
  barrier.release();
  await client.query('BEGIN');
  await client.query(insert(), [1, 'still transactional']);
  expect((await barrier.entered).parameters).toEqual([1, 'still transactional']);
  await trace.close();
  expect(client.query).toBe(original);
  expect(client.getTransactionStatus()).toBe('T');
  expect(await ids()).toEqual([]);
  await client.query('COMMIT');
  expect(await ids()).toEqual([1]);
});
