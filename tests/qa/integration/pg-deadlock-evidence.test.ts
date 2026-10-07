import { randomUUID } from 'node:crypto';
import { expect, test } from 'bun:test';
import { Query, type PoolClient, type QueryResult } from 'pg';
import { boundedPool } from '../../../services/main/src/infrastructure/pg-pool.ts';

function databaseUrl(): string {
  const url = Bun.env.ACCESS_DATABASE_URL;
  if (!Bun.env.REZICS_QA_RUN_ID || !url) throw new Error('Run through isolated QA integration');
  return url;
}

function captureFaults() {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    lines.push(args.join(' '));
  };
  return {
    lines,
    restore: () => {
      console.error = original;
    },
    deadlocks: () =>
      lines
        .map((line) => JSON.parse(line))
        .filter(
          (line) =>
            line.event === 'worker_fault' &&
            line['rezics.worker.name'] === 'main.database.deadlock',
        ),
  };
}

test('a real deadlock is recorded once before owner translation and both clients recover by rollback', async () => {
  const config = { connectionString: databaseUrl(), max: 1 };
  const leftPool = boundedPool(config);
  const rightPool = boundedPool(config);
  const table = `public.deadlock_${randomUUID().replaceAll('-', '')}`;
  const faults = captureFaults();
  const left = await leftPool.connect();
  const right = await rightPool.connect();
  const received: unknown[] = [];
  for (const client of [left, right]) {
    client.connection.prependListener('errorMessage', (error: unknown) => {
      received.push(error);
    });
  }
  try {
    await left.query(`CREATE TABLE ${table} (id integer PRIMARY KEY, value text)`);
    await left.query(`INSERT INTO ${table} VALUES (1, $1), (2, $1)`, ['private-row-value']);
    const leftPid = (await left.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
    const rightPid = (await right.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
    await left.query('BEGIN');
    await right.query('BEGIN');
    await left.query(`SELECT * FROM ${table} WHERE id = 1 FOR UPDATE`);
    await right.query(`SELECT * FROM ${table} WHERE id = 2 FOR UPDATE`);
    const outcome = async (client: PoolClient, id: number) => {
      try {
        return {
          result: await client.query(`UPDATE ${table} SET value = $1 WHERE id = $2`, [
            'private-update-parameter',
            id,
          ]),
          error: undefined,
        };
      } catch (error) {
        // An owner may translate this into its own outcome; evidence already exists.
        expect(faults.deadlocks()).toHaveLength(1);
        await client.query('ROLLBACK');
        return { result: undefined, error };
      }
    };
    const leftOutcome = outcome(left, 2);
    const deadline = performance.now() + 2_000;
    let waiting = false;
    while (!waiting && performance.now() < deadline) {
      waiting = (
        await right.query('SELECT $1 = ANY(pg_blocking_pids($2)) AS waiting', [rightPid, leftPid])
      ).rows[0].waiting as boolean;
      if (!waiting) await Bun.sleep(10);
    }
    expect(waiting).toBe(true);
    const outcomes = await Promise.all([leftOutcome, outcome(right, 1)]);
    const failed = outcomes.filter((item) => item.error !== undefined);
    expect(failed).toHaveLength(1);
    expect(failed[0]!.error).toBe(received[0]);
    expect(failed[0]!.error).toHaveProperty('code', '40P01');
    expect(outcomes.find((item) => item.result)?.result?.rowCount).toBe(1);
    expect(faults.deadlocks()).toHaveLength(1);
    expect(faults.lines).toHaveLength(1);
    for (const [client, pid] of [
      [left, leftPid],
      [right, rightPid],
    ] as const) {
      await client.query('ROLLBACK');
      expect((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid).toBe(pid);
    }
    expect(faults.lines.join('\n')).not.toContain('private');
    expect(faults.lines.join('\n')).not.toContain(table);
  } finally {
    await Promise.all([left.query('ROLLBACK'), right.query('ROLLBACK')]);
    await left.query(`DROP TABLE IF EXISTS ${table}`);
    left.release();
    right.release();
    await Promise.all([leftPool.end(), rightPool.end()]);
    faults.restore();
  }
}, 20_000);

test('pool and borrowed query forms preserve errors, results and lifecycle without leaking query data', async () => {
  const pool = boundedPool({ connectionString: databaseUrl(), max: 1 });
  const schema = `deadlock_${randomUUID().replaceAll('-', '')}`;
  const privateMessage = 'private-error-message';
  const privateParameter = 'private-query-parameter';
  const sql = `SELECT ${schema}.fail($1) /* private-sql-text */`;
  const faults = captureFaults();
  const received: unknown[] = [];
  pool.on('connect', (client) => {
    client.connection.prependListener('errorMessage', (error: unknown) => {
      received.push(error);
    });
  });
  const assertFailure = (error: unknown, count: number) => {
    expect(error).toBe(received.at(-1));
    expect(error).toHaveProperty('code', '40P01');
    expect(error).toHaveProperty('message', `${privateMessage}:${privateParameter}`);
    expect(faults.deadlocks()).toHaveLength(count);
  };
  try {
    await pool.query(`CREATE SCHEMA ${schema}`);
    await pool.query(`CREATE FUNCTION ${schema}.fail(value text) RETURNS integer LANGUAGE plpgsql AS
      $$ BEGIN RAISE EXCEPTION USING ERRCODE = '40P01', MESSAGE = '${privateMessage}:' || value; END $$`);
    const result = await pool.query<{ value: string }>('SELECT $1::text AS value', [
      privateParameter,
    ]);
    expect(result.rows).toEqual([{ value: privateParameter }]);
    await expect(pool.query('SELECT $1::integer', [privateParameter])).rejects.toHaveProperty(
      'code',
      '22P02',
    );
    expect(faults.lines).toHaveLength(0);
    const promiseError = await pool.query(sql, [privateParameter]).catch((error: unknown) => error);
    assertFailure(promiseError, 1);
    await new Promise<void>((resolve, reject) => {
      const returned = pool.query(sql, [privateParameter], (error, result) => {
        try {
          assertFailure(error, 2);
          expect(result).toBeUndefined();
          resolve();
        } catch (failure) {
          reject(failure);
        }
      });
      expect(returned).toBeUndefined();
    });
    await new Promise<void>((resolve, reject) => {
      const returned = pool.query('SELECT 7 AS value', (error, result) => {
        try {
          expect(error).toBeUndefined();
          expect(result.rows).toEqual([{ value: 7 }]);
          resolve();
        } catch (failure) {
          reject(failure);
        }
      });
      expect(returned).toBeUndefined();
    });
    const client = await pool.connect();
    try {
      const borrowedError = await client
        .query({ text: sql, values: [privateParameter] })
        .catch((error: unknown) => error);
      assertFailure(borrowedError, 3);
      await new Promise<void>((resolve, reject) => {
        const returned = client.query(sql, (error) => {
          try {
            // No parameters in this overload: the original bind error stays a nondeadlock.
            expect(error).toBe(received.at(-1) as Error);
            expect(error).toHaveProperty('code', '42P02');
            expect(faults.deadlocks()).toHaveLength(3);
            resolve();
          } catch (failure) {
            reject(failure);
          }
        });
        expect(returned).toBeUndefined();
      });
      await new Promise<void>((resolve, reject) => {
        const returned = client.query(sql, [privateParameter], (error) => {
          try {
            assertFailure(error, 4);
            resolve();
          } catch (failure) {
            reject(failure);
          }
        });
        expect(returned).toBeUndefined();
      });
      await new Promise<void>((resolve, reject) => {
        const query = new Query(sql, [privateParameter]);
        query.on('error', (error) => {
          try {
            assertFailure(error, 5);
            resolve();
          } catch (failure) {
            reject(failure);
          }
        });
        expect(client.query(query)).toBe(query);
      });
      await new Promise<void>((resolve, reject) => {
        client.query(
          { text: 'SELECT $1::text AS value', values: [privateParameter], rowMode: 'array' },
          (error, result) => {
            try {
              expect(error).toBeNull();
              expect(result.rows).toEqual([[privateParameter]]);
              resolve();
            } catch (failure) {
              reject(failure);
            }
          },
        );
      });
      expect(() => client.query(null as unknown as string)).toThrow(TypeError);
      expect(faults.deadlocks()).toHaveLength(5);
    } finally {
      client.release();
    }
    const reused: QueryResult = await pool.query('SELECT 1');
    expect(reused.rowCount).toBe(1);
    expect(pool.totalCount).toBe(1);
    expect(faults.lines).toHaveLength(5);
    for (const line of faults.deadlocks()) {
      expect(line).toMatchObject({
        level: 'error',
        event: 'worker_fault',
        'rezics.worker.name': 'main.database.deadlock',
        'error.class': 'DatabaseError',
        'error.code': '40P01',
      });
    }
    for (const secret of [
      privateMessage,
      privateParameter,
      'private-sql-text',
      schema,
      databaseUrl(),
    ]) {
      expect(faults.lines.join('\n')).not.toContain(secret);
    }
  } finally {
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await pool.end();
    faults.restore();
  }
}, 20_000);
