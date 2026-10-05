import { randomUUID } from 'node:crypto';
import { expect, test } from 'bun:test';
import { Pool } from 'pg';
import { boundedPool, CONNECTION_BOUNDS } from '../../../services/main/src/infrastructure/pg-pool.ts';

function url(name: 'ACCESS_DATABASE_URL' | 'CONTENT_DATABASE_URL' | 'ACCOUNT_DATABASE_URL'
  | 'ACCOUNT_RELAY_DATABASE_URL'): string {
  const value = Bun.env[name];
  if (!Bun.env.REZICS_QA_RUN_ID || !value) throw new Error('Run through the isolated QA integration tier');
  return value;
}

const owners = ['ACCESS_DATABASE_URL', 'CONTENT_DATABASE_URL', 'ACCOUNT_DATABASE_URL',
  'ACCOUNT_RELAY_DATABASE_URL'] as const;

test('request pools report the connection defaults on every owner database', async () => {
  for (const owner of owners) {
    const pool = boundedPool({ connectionString: url(owner), max: 1 });
    try {
      const shown = await pool.query<{ lock: string; idle: string; transaction: string }>(
        `SELECT current_setting('lock_timeout') AS lock,
                current_setting('idle_in_transaction_session_timeout') AS idle,
                current_setting('transaction_timeout') AS transaction`);
      expect(shown.rows[0], owner).toEqual({ lock: '5s', idle: '1min', transaction: '5min' });
    } finally { await pool.end(); }
  }
});

test('request pools keep a read-only session option beside the bounds', async () => {
  const pool = boundedPool({ connectionString: url('ACCOUNT_RELAY_DATABASE_URL'), max: 1,
    options: '-c default_transaction_read_only=on' });
  try {
    const shown = await pool.query<{ readonly: string; lock: string }>(
      `SELECT current_setting('default_transaction_read_only') AS readonly,
              current_setting('lock_timeout') AS lock`);
    expect(shown.rows[0]).toEqual({ readonly: 'on', lock: CONNECTION_BOUNDS.lockTimeout });
  } finally { await pool.end(); }
});

test('a lock wait on a request pool fails within the bound', async () => {
  const table = `connection_bounds_${randomUUID().replaceAll('-', '')}`;
  const owner = new Pool({ connectionString: url('ACCESS_DATABASE_URL'), max: 1 });
  const holder = await owner.connect();
  const pool = boundedPool({ connectionString: url('ACCESS_DATABASE_URL'), max: 1 });
  try {
    await holder.query(`CREATE TABLE public.${table} (id integer)`);
    await holder.query('BEGIN');
    await holder.query(`LOCK TABLE public.${table} IN ACCESS EXCLUSIVE MODE`);
    const started = performance.now();
    // No SET LOCAL here: the pool default is the only bound on this wait.
    const waiting = await pool.query(`SELECT count(*) FROM public.${table}`).then(
      () => undefined, (error: { code?: string }) => error);
    const waited = performance.now() - started;
    expect(waiting?.code).toBe('55P03');
    expect(waited).toBeGreaterThan(4_000);
    expect(waited).toBeLessThan(10_000);
  } finally {
    try { await holder.query('ROLLBACK'); } finally { holder.release(); }
    await owner.query(`DROP TABLE IF EXISTS public.${table}`);
    await owner.end();
    await pool.end();
  }
}, 30_000);

test('a connection left idle in a transaction is closed and the pool recovers', async () => {
  // The bound is shortened here; the code path is the same one that applies 60 s.
  const pool = boundedPool({ connectionString: url('ACCESS_DATABASE_URL'), max: 1 },
    { ...CONNECTION_BOUNDS, idleInTransactionSessionTimeout: '1s' });
  const errors: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { errors.push(args.join(' ')); };
  try {
    const stuck = await pool.connect();
    const pid = (await stuck.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
    await stuck.query('BEGIN');
    await stuck.query('SELECT 1');
    await Bun.sleep(2_500);
    // The server ended the session; the process survived and logged the failure.
    await expect(stuck.query('SELECT 1')).rejects.toThrow();
    stuck.release(true);
    const fresh = await pool.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    expect(fresh.rows[0]!.pid).not.toBe(pid);
    expect(errors.join('\n')).toContain('Database connection failed');
  } finally {
    console.error = original;
    await pool.end();
  }
}, 30_000);

test('a transaction past its total bound is closed even while it keeps working', async () => {
  const pool = boundedPool({ connectionString: url('ACCESS_DATABASE_URL'), max: 1 },
    { ...CONNECTION_BOUNDS, transactionTimeout: '1s' });
  const original = console.error;
  console.error = () => {};
  try {
    const busy = await pool.connect();
    await busy.query('BEGIN');
    await busy.query('SELECT pg_sleep(1.5)').catch(() => undefined);
    await expect(busy.query('SELECT 1')).rejects.toThrow();
    busy.release(true);
    expect((await pool.query('SELECT 1')).rowCount).toBe(1);
  } finally {
    console.error = original;
    await pool.end();
  }
}, 30_000);
