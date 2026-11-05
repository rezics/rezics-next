import { afterAll, beforeAll, expect, test } from 'bun:test';
import { Type } from 'typebox';
import { Value } from 'typebox/value';
import { runCommand, type CommandAuthorization, type CommandEvent } from '../../src/command/command.ts';
import { createPool } from '../../src/database/pool.ts';
import { EVENT_TYPES, lookupEventType, registerEventTypes } from '../../src/events/catalogue.ts';
import { EVENT_TYPES as readerTypes, readBatch, type Envelope } from '../../src/events/log.ts';
import { problemResponse } from '../../src/http/problem.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(databaseUrl);
const partition = 15;
const type = 'com.rezics.fixture.registration.v1';
const schema = Type.Object({ n: Type.Integer() }, { additionalProperties: false });
registerEventTypes({ [type]: schema });
const compiled = lookupEventType(type)!;
const actorAccountId = '10000000-0000-4000-8000-000000000001';

beforeAll(async () => {
  await pool.query('CREATE TABLE public.event_registration_domain (value integer)');
});
afterAll(async () => {
  await pool.query('DROP TABLE public.event_registration_domain');
  await pool.end();
});

async function refused(event: CommandEvent): Promise<unknown> {
  let finalized = false;
  const authorization: CommandAuthorization = {
    action: 'fixture:write',
    resource: { route: partition, id: actorAccountId },
    async authorize() {
      return 'execute';
    },
    async finalize() {
      finalized = true;
    },
    denied: () => new Error('denied'),
  };
  const error: unknown = await runCommand(
    pool,
    {
      partition,
      basis: { actorAccountId, clientId: 'registration', requestedBy: null },
      receipt: { actorAccountId, kind: 'fixture.registration', key: 'refused', digest: new Uint8Array(32) },
      authorization,
    },
    async (tx) => {
      await tx.query('INSERT INTO public.event_registration_domain VALUES (1)');
      return { value: true, events: [event] };
    },
  ).catch((error: unknown) => error);
  expect(error).toBeInstanceOf(TypeError);
  expect(finalized).toBe(false);
  expect(problemResponse(error, { method: 'POST', id: 'registration' }).status).toBe(500);
  for (const relation of ['public.event_registration_domain', 'core.receipt', 'core.outbox', 'editorial.write_basis']) {
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM ${relation}`);
    expect(rows).toEqual([{ n: 0 }]);
  }
  const { rows } = await pool.query('SELECT position::int AS n FROM core.partition WHERE partition_no=$1', [partition]);
  expect(rows).toEqual([{ n: 0 }]);
  return error;
}

test('unregistered types are programming errors and roll back all command writes', async () => {
  expect(await refused({ type: 'com.rezics.unregistered.v1', data: {} })).toMatchObject({
    message: expect.stringContaining('com.rezics.unregistered.v1'),
  });
});

test('invalid stored JSON data reports the type and first schema error before finalize or fence', async () => {
  const invalid = { n: 'bad' };
  const first = Value.Errors(schema, invalid)[0]!;
  const lock = await pool.connect();
  try {
    await lock.query('BEGIN');
    await lock.query('UPDATE core.partition SET position=position WHERE partition_no=$1', [partition]);
    const error = await refused({ type, data: { toJSON: () => invalid } });
    expect((error as Error).message).toContain(`${first.instancePath} ${first.message}`);
    expect((error as Error).message).toContain(type);
  } finally {
    await lock.query('ROLLBACK');
    lock.release();
  }
});

test('non-JSON event data is refused without sealing startup registration', async () => {
  await refused({ type, data: undefined });
  await refused({ type, data: { n: 1n } });
  expect(() => registerEventTypes({ [type]: schema })).toThrow(/Duplicate event type/);
  registerEventTypes({ 'com.rezics.fixture.after-refusal.v1': Type.Null() });
});

test('registered JSON snapshots commit, read back unchanged, and seal registration', async () => {
  expect(readerTypes()).toBe(EVENT_TYPES());
  expect(EVENT_TYPES()[type]).toBe(schema);
  expect(compiled.IsAccelerated()).toBe(true);
  const data = { n: 7, omitted: undefined };
  const result = await runCommand(
    pool,
    {
      partition,
      authorization: {
        action: 'fixture:write',
        resource: { route: partition, id: actorAccountId },
        async authorize() {
          return 'execute';
        },
        async finalize() {
          data.n = 99;
        },
        denied: () => new Error('denied'),
      },
    },
    async () => ({ value: true, events: [{ type, subject: 'fixture', data }] }),
  );
  const envelopes: Envelope[] = [];
  expect(
    await readBatch(pool, {
      consumer: 'registration',
      partition,
      async apply(batch) {
        envelopes.push(...batch);
      },
    }),
  ).toMatchObject({ status: 'read', envelopes: 1, position: result.position });
  expect(envelopes[0]!.events[0]).toMatchObject({ type, subject: 'fixture', data: { n: 7 } });
  expect(envelopes[0]!.events[0]!.data).toEqual({ n: 7 });
  expect(lookupEventType(type)).toBe(compiled);
  expect(() => registerEventTypes({ 'com.rezics.fixture.late.v1': Type.Null() })).toThrow(/sealed/);
  expect(() => registerEventTypes({})).toThrow(/sealed/);
});
