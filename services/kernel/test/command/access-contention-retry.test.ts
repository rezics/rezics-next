import { afterAll, beforeAll, expect, test } from 'bun:test';
import { Type } from 'typebox';
import { runCommand, type CommandAuthorization } from '../../src/command/command.ts';
import { deadlineClient } from '../../src/access/authenticate.ts';
import { AccessUnavailableError } from '../../src/access/unavailable.ts';
import { createPool } from '../../src/database/pool.ts';
import { registerEventTypes } from '../../src/events/catalogue.ts';
import { problemResponse } from '../../src/http/problem.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(databaseUrl);
const partition = 15;
const eventType = 'com.rezics.fixture.access-contention.v1';
registerEventTypes({ [eventType]: Type.Object({ attempt: Type.Integer() }, { additionalProperties: false }) });

beforeAll(async () => {
  await pool.query('CREATE TABLE public.access_contention_effect (id uuid PRIMARY KEY)');
  await pool.query('CREATE TABLE public.access_contention_lock (id uuid PRIMARY KEY, value integer NOT NULL)');
});
afterAll(async () => {
  await pool.query('DROP TABLE public.access_contention_lock');
  await pool.query('DROP TABLE public.access_contention_effect');
  await pool.end();
});

function authorizationFor(
  authorize: CommandAuthorization['authorize'],
  prepare: NonNullable<CommandAuthorization['prepare']>,
): CommandAuthorization {
  return {
    action: 'fixture:write',
    resource: { route: partition, id: '10000000-0000-4000-8000-000000000001' },
    prepare,
    authorize,
    denied: () => new Error('denied'),
  };
}

test('a serialization failure raised through an Access query inside a command transaction is retried and the command commits once', async () => {
  const key = crypto.randomUUID();
  const lockId = crypto.randomUUID();
  await pool.query('INSERT INTO public.access_contention_lock VALUES ($1, 0)', [lockId]);
  let attempts = 0;
  let prepared = 0;
  let conflictInjected = false;
  const deadline = Date.now() + 5000;
  const authorization = authorizationFor(
    async (tx) => {
      attempts++;
      const accessQuery = deadlineClient(tx, deadline);
      // Establish the command transaction's serializable snapshot through an
      // Access read, then commit a concurrent update before its locking read.
      await accessQuery.query('SELECT value FROM public.access_contention_lock WHERE id=$1', [lockId]);
      if (!conflictInjected) {
        conflictInjected = true;
        const concurrent = await pool.connect();
        try {
          await concurrent.query('BEGIN');
          await concurrent.query('UPDATE public.access_contention_lock SET value=value+1 WHERE id=$1', [lockId]);
          await concurrent.query('COMMIT');
        } catch (error) {
          await concurrent.query('ROLLBACK');
          throw error;
        } finally {
          concurrent.release();
        }
      }
      // The competing commit invalidated this transaction's snapshot. PostgreSQL
      // raises 40001 here; deadlineClient maps that Access query failure to the
      // same AccessUnavailableError used by native Access operations.
      await accessQuery.query('SELECT value FROM public.access_contention_lock WHERE id=$1 FOR UPDATE', [lockId]);
      return 'execute';
    },
    async () => {
      prepared++;
      return {};
    },
  );
  const result = await runCommand(
    pool,
    {
      partition,
      deadline,
      basis: { actorAccountId: '10000000-0000-4000-8000-000000000001', clientId: 'contention', requestedBy: null },
      receipt: {
        actorAccountId: '10000000-0000-4000-8000-000000000001',
        kind: 'fixture.access-contention',
        key,
        digest: Buffer.alloc(32, 17),
      },
      authorization,
    },
    async (tx) => {
      await tx.query('INSERT INTO public.access_contention_effect VALUES ($1)', [crypto.randomUUID()]);
      return { value: true, events: [{ type: eventType, data: { attempt: attempts } }] };
    },
  );
  expect(result.replayed).toBe(false);
  expect(attempts).toBe(2);
  expect(prepared).toBe(2);
  const { rows } = await pool.query(
    `SELECT
       (SELECT count(*)::int FROM public.access_contention_effect) AS body,
       (SELECT count(*)::int FROM core.receipt WHERE command_kind='fixture.access-contention' AND idempotency_key=$1) AS receipts,
       (SELECT count(*)::int FROM core.outbox WHERE partition_no=$2 AND position=$3) AS events`,
    [key, partition, result.position.toString()],
  );
  expect(rows).toEqual([{ body: 1, receipts: 1, events: 1 }]);
});

test('Access contention that outlasts the command deadline answers the same AccessUnavailableError with no effects', async () => {
  const key = crypto.randomUUID();
  const cause = new AccessUnavailableError('contention');
  const deadline = Date.now() + 500;
  let attempts = 0;
  const authorization = authorizationFor(
    async () => {
      attempts++;
      throw cause;
    },
    async () => ({}),
  );
  const before = await pool.query(
    `SELECT
       (SELECT count(*)::int FROM core.receipt WHERE command_kind='fixture.access-contention' AND idempotency_key=$1) AS receipts,
       (SELECT count(*)::int FROM core.outbox) AS events,
       (SELECT count(*)::int FROM public.access_contention_effect) AS body`,
    [key],
  );
  const caught = await runCommand(
    pool,
    {
      partition,
      deadline,
      basis: { actorAccountId: '10000000-0000-4000-8000-000000000001', clientId: 'contention', requestedBy: null },
      receipt: {
        actorAccountId: '10000000-0000-4000-8000-000000000001',
        kind: 'fixture.access-contention',
        key,
        digest: Buffer.alloc(32, 19),
      },
      authorization,
    },
    async (tx) => {
      await tx.query('INSERT INTO public.access_contention_effect VALUES ($1)', [crypto.randomUUID()]);
      return { value: true, events: [{ type: eventType, data: { attempt: attempts } }] };
    },
  ).catch((error: unknown) => error);
  expect(caught).toBe(cause);
  expect((caught as AccessUnavailableError).reason).toBe('contention');
  expect(problemResponse(caught, { method: 'POST', id: 'access-contention' }).status).toBe(503);
  expect(attempts).toBeGreaterThan(0);
  const after = await pool.query(
    `SELECT
       (SELECT count(*)::int FROM core.receipt WHERE command_kind='fixture.access-contention' AND idempotency_key=$1) AS receipts,
       (SELECT count(*)::int FROM core.outbox) AS events,
       (SELECT count(*)::int FROM public.access_contention_effect) AS body`,
    [key],
  );
  expect(after.rows).toEqual(before.rows);
});
