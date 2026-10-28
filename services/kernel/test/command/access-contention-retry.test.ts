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
});
afterAll(async () => {
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
  let attempts = 0;
  let prepared = 0;
  let accessFailures = 0;
  const deadline = Date.now() + 5000;
  const authorization = authorizationFor(
    async (tx) => {
      attempts++;
      if (accessFailures++ === 0) {
        // This Access query runs on the command transaction's client. PostgreSQL
        // returns the serialization SQLSTATE and the Access deadline wrapper
        // turns it into AccessUnavailableError('contention').
        await deadlineClient(tx, deadline).query(
          "DO $$ BEGIN RAISE EXCEPTION 'serialization conflict' USING ERRCODE = '40001'; END $$",
        );
      }
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
  expect(accessFailures).toBe(2);
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
  const deadline = Date.now() + 45;
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
