import { afterAll, beforeAll, expect, test } from 'bun:test';
import { DBOS } from '@dbos-inc/dbos-sdk';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';
import { createPool } from '../src/database/pool.ts';
import {
  DBOS_SCHEMA,
  EFFECTS_CONSUMER,
  EFFECTS_QUEUE,
  effectWorkflowId,
  launchWork,
  registerEffects,
  relayEffects,
  shutdownWork,
} from '../src/events/effects.ts';
import { readBatch, type CloudEvent, type Envelope } from '../src/events/log.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(databaseUrl);
const admin = new pg.Pool({ connectionString: databaseUrl, max: 2 });

const CREATED = 'com.rezics.subject.created.v1';
const CONTEXT_CREATED = 'com.rezics.semantic.context.created.v1';
const recorded: CloudEvent[] = [];
const attempts = new Map<string, number>();
const failingAttempts = new Map<string, number>();
const orderedRecorded: string[] = [];
const effects = registerEffects([
  { name: 'record', types: [CREATED], run: async (event) => void recorded.push(event) },
  {
    name: 'flaky',
    types: [CREATED],
    run: async (event) => {
      const attempt = (attempts.get(event.subject!) ?? 0) + 1;
      attempts.set(event.subject!, attempt);
      if (attempt === 1) throw new Error('the first attempt fails');
    },
  },
  {
    name: 'always_fails',
    types: [CONTEXT_CREATED],
    run: async (event) => {
      const subject = event.subject!;
      failingAttempts.set(subject, (failingAttempts.get(subject) ?? 0) + 1);
      throw new Error('this effect always fails');
    },
  },
  {
    name: 'ordered_record',
    types: [CONTEXT_CREATED],
    run: async (event) => void orderedRecorded.push(event.subject!),
  },
]);

beforeAll(() => launchWork({ databaseUrl }));
afterAll(async () => {
  await shutdownWork();
  await pool.end();
  await admin.end();
});

let nextPartition = 3072 + Math.floor(Math.random() * 512);
const freshPartition = () => nextPartition++;

/** Appends one subject.created envelope as the fence does, and returns its position and event. */
async function appendCreated(
  partition: number,
  type = CREATED,
): Promise<{ epoch: number; position: bigint; subject: string }> {
  const subject = crypto.randomUUID();
  const client = await admin.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{ epoch: number; position: string }>(
      'UPDATE core.partition SET position = position + 1 WHERE partition_no = $1 RETURNING epoch, position::text',
      [partition],
    );
    const { epoch, position } = rows[0]!;
    await client.query(
      `INSERT INTO core.outbox (partition_no, position, event_seq, event_count, epoch, id, type, subject, data)
       VALUES ($1, $2, 0, 1, $3, $4, $5, $6, $7)`,
      [partition, position, epoch, Bun.randomUUIDv7(), type, subject, JSON.stringify({ id: subject })],
    );
    await client.query('COMMIT');
    return { epoch, position: BigInt(position), subject };
  } finally {
    client.release();
  }
}

/** Relays the partition up to its head. */
async function relay(partition: number): Promise<void> {
  for (;;) {
    const result = await relayEffects(pool, effects, partition);
    if (result.status !== 'read') throw new Error(`could not relay partition ${partition}: ${result.status}`);
    if (result.envelopes === 0) return;
  }
}

const recordedFor = (subject: string) => recorded.filter((event) => event.subject === subject);
const envelopeAt = (partition: number, epoch: number, position: bigint): Envelope => ({
  partition,
  epoch,
  position,
  events: [],
});

async function until(condition: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('condition not reached');
    await Bun.sleep(25);
  }
}

test('DBOS keeps its tables in their own schema, outside the committed dump', async () => {
  expect(DBOS_SCHEMA).toBe('dbos');
  const { rows } = await admin.query<{ tables: number }>(
    'SELECT count(*)::int AS tables FROM information_schema.tables WHERE table_schema = $1',
    [DBOS_SCHEMA],
  );
  expect(rows[0]!.tables).toBeGreaterThan(0);
  const dump = readFileSync(resolve(import.meta.dir, '../db/schema.sql'), 'utf8');
  expect(dump).not.toMatch(/\bdbos\./);
});

test('each event runs each of its effects once, as a DBOS workflow named by its position', async () => {
  const partition = freshPartition();
  const { epoch, position, subject } = await appendCreated(partition);
  await relay(partition);

  const id = effectWorkflowId(envelopeAt(partition, epoch, position), 0, 'record');
  expect(id).toBe(`fx:${epoch}:${partition}:${position}:0:record`);
  await DBOS.retrieveWorkflow(id).getResult();
  expect(await DBOS.getWorkflowStatus(id)).toMatchObject({
    status: 'SUCCESS',
    workflowName: 'effect',
    queueName: EFFECTS_QUEUE,
  });
  expect(recordedFor(subject)).toEqual([
    {
      specversion: '1.0',
      id: expect.any(String),
      source: `urn:rezics:log:${partition}.${epoch}`,
      type: CREATED,
      subject,
      time: expect.any(String),
      datacontenttype: 'application/json',
      sequence: position.toString().padStart(19, '0'),
      data: { id: subject },
    },
  ]);

  await effects.enqueue([{ ...envelopeAt(partition, epoch, position), events: recordedFor(subject) }]);
  await DBOS.retrieveWorkflow(id).getResult();
  expect(recordedFor(subject)).toHaveLength(1);
  expect(await relayEffects(pool, effects, partition)).toEqual({ status: 'read', envelopes: 0, position });
}, 20_000);

test('a failing effect is retried by DBOS until it succeeds', async () => {
  const partition = freshPartition();
  const { epoch, position, subject } = await appendCreated(partition);
  await relay(partition);
  const id = effectWorkflowId(envelopeAt(partition, epoch, position), 0, 'flaky');
  await DBOS.retrieveWorkflow(id).getResult();
  expect(attempts.get(subject)).toBe(2);
  expect(await DBOS.getWorkflowStatus(id)).toMatchObject({ status: 'SUCCESS' });
}, 20_000);

test("an effect that always fails leaves another effect's events on the same partition completed, in position order", async () => {
  const partition = freshPartition();
  const first = await appendCreated(partition, CONTEXT_CREATED);
  const second = await appendCreated(partition, CONTEXT_CREATED);
  const envelopes: Envelope[] = [first, second].map(({ epoch, position }) => envelopeAt(partition, epoch, position));
  const failingWorkflowIds = envelopes.map((envelope) => effectWorkflowId(envelope, 0, 'always_fails'));
  const recordingWorkflowIds = envelopes.map((envelope) => effectWorkflowId(envelope, 0, 'ordered_record'));

  try {
    await relay(partition);
    await until(async () => {
      const statuses = await Promise.all(recordingWorkflowIds.map((id) => DBOS.getWorkflowStatus(id)));
      return statuses.every((status) => status?.status === 'SUCCESS') && failingAttempts.get(first.subject)! > 0;
    });

    expect(orderedRecorded.slice(-2)).toEqual([first.subject, second.subject]);
    expect(await DBOS.getWorkflowStatus(failingWorkflowIds[0]!)).toMatchObject({ status: 'PENDING' });
    expect(failingAttempts.get(first.subject)).toBeGreaterThan(0);
    expect(failingAttempts.get(first.subject)).toBeLessThan(10);
  } finally {
    await DBOS.cancelWorkflows(failingWorkflowIds);
  }
}, 20_000);

test('a batch that fails after enqueuing is read again and finds the workflows it started', async () => {
  const partition = freshPartition();
  await relay(partition);
  const { epoch, position, subject } = await appendCreated(partition);
  const failure = new Error('the batch fails after enqueuing');
  await expect(
    readBatch(pool, {
      consumer: EFFECTS_CONSUMER,
      partition,
      apply: async (envelopes) => {
        await effects.enqueue(envelopes);
        throw failure;
      },
    }),
  ).rejects.toBe(failure);
  expect(await relayEffects(pool, effects, partition)).toEqual({ status: 'read', envelopes: 1, position });
  await DBOS.retrieveWorkflow(effectWorkflowId(envelopeAt(partition, epoch, position), 0, 'record')).getResult();
  expect(recordedFor(subject)).toHaveLength(1);
}, 20_000);

test('effects have distinct lowercase names and follow known event types', () => {
  const run = async () => {};
  expect(() => registerEffects([{ name: 'Record', types: [CREATED], run }])).toThrow(RangeError);
  expect(() =>
    registerEffects([
      { name: 'twice', types: [CREATED], run },
      { name: 'twice', types: [CREATED], run },
    ]),
  ).toThrow(RangeError);
  expect(() => registerEffects([{ name: 'unknown', types: ['com.rezics.unknown.v1'], run }])).toThrow(RangeError);
});
