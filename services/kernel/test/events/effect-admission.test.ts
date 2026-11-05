import { afterAll, beforeAll, expect, test } from 'bun:test';
import { DBOS } from '@dbos-inc/dbos-sdk';
import pg, { type PoolClient } from 'pg';
import {
  EFFECTS_CONSUMER,
  effectWorkflowId,
  launchWork,
  registerEffects,
  relayEffects,
  shutdownWork,
  type Effect,
} from '../../src/events/effects.ts';
import type { CloudEvent, Envelope } from '../../src/events/log.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');

// A single relay connection makes connection release before enqueue observable.
const relayPool = new pg.Pool({ connectionString: databaseUrl, max: 1, idleTimeoutMillis: 300_000 });
const admin = new pg.Pool({ connectionString: databaseUrl, max: 2 });
const CREATED = 'com.rezics.subject.created.v1';
const CONTEXT_CREATED = 'com.rezics.semantic.context.created.v1';

type Draft = { type: string; id: string; data: { id: string } };
type Appended = { epoch: number; position: bigint; eventIds: string[]; time: string };

const admissionOrder: string[] = [];
const legacyRuns: string[] = [];
const ownerRuns = new Map<string, number>();
let failAdmissionId: string | undefined;
let admissionFailure: Error | undefined;

async function insertOwnerItem(client: PoolClient, event: CloudEvent): Promise<void> {
  await client.query(
    `INSERT INTO pg_temp.effect_admission_owner_item(work_id,state,changed_at)
     VALUES ($1,'pending',$2) ON CONFLICT (work_id) DO NOTHING`,
    [event.id, event.time],
  );
}

async function runOwnerItem(event: CloudEvent): Promise<void> {
  await relayPool.query(
    `INSERT INTO pg_temp.effect_admission_owner_item(work_id,state,changed_at)
     VALUES ($1,'pending',$2) ON CONFLICT (work_id) DO NOTHING`,
    [event.id, event.time],
  );
  const result = await relayPool.query(
    `UPDATE pg_temp.effect_admission_owner_item SET state='processed'
     WHERE work_id=$1 AND state='pending' RETURNING work_id`,
    [event.id],
  );
  if ((result.rowCount ?? 0) > 0) ownerRuns.set(event.id, (ownerRuns.get(event.id) ?? 0) + 1);
}

const ownerEffect: Effect = {
  name: 'admission_owner',
  types: [CREATED],
  async admit(client, event) {
    admissionOrder.push(event.id);
    await insertOwnerItem(client, event);
  },
  run: runOwnerItem,
};

const legacyEffect: Effect = {
  name: 'legacy_record',
  types: [CREATED],
  async run(event) {
    legacyRuns.push(event.id);
  },
};

const rollbackEffect: Effect = {
  name: 'admission_rollback',
  types: [CONTEXT_CREATED],
  async admit(client, event) {
    await insertOwnerItem(client, event);
    if (event.id === failAdmissionId) throw admissionFailure;
  },
  async run() {},
};

const effects = registerEffects([ownerEffect, legacyEffect, rollbackEffect]);
const enqueue = effects.enqueue.bind(effects);

beforeAll(async () => {
  await relayPool.query(`CREATE TEMP TABLE effect_admission_owner_item (
    work_id uuid PRIMARY KEY,
    state text NOT NULL,
    changed_at timestamptz NOT NULL
  )`);
  await launchWork({ databaseUrl });
});

afterAll(async () => {
  await shutdownWork();
  await Promise.all([relayPool.end(), admin.end()]);
});

let nextPartition = 3600 + Math.floor(Math.random() * 300);
const freshPartition = () => nextPartition++;

async function append(partition: number, types: readonly string[]): Promise<Appended> {
  const events: Draft[] = types.map((type) => ({ type, id: crypto.randomUUID(), data: { id: crypto.randomUUID() } }));
  const time = new Date().toISOString();
  const client = await admin.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{ epoch: number; position: string }>(
      'UPDATE core.partition SET position=position+1 WHERE partition_no=$1 RETURNING epoch,position::text',
      [partition],
    );
    const { epoch, position } = rows[0]!;
    for (const [eventSeq, event] of events.entries()) {
      await client.query(
        `INSERT INTO core.outbox
         (partition_no,position,event_seq,event_count,epoch,id,type,subject,data,recorded_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          partition,
          position,
          eventSeq,
          events.length,
          epoch,
          event.id,
          event.type,
          event.data.id,
          JSON.stringify(event.data),
          time,
        ],
      );
    }
    await client.query('COMMIT');
    return { epoch, position: BigInt(position), eventIds: events.map((event) => event.id), time };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function checkpoint(partition: number): Promise<string> {
  const { rows } = await admin.query<{ position: string }>(
    'SELECT position::text FROM core.consumer_checkpoint WHERE consumer=$1 AND partition_no=$2',
    [EFFECTS_CONSUMER, partition],
  );
  return rows[0]?.position ?? '0';
}

async function ownerItem(id: string): Promise<{ state: string; changed_at: Date } | undefined> {
  const { rows } = await relayPool.query<{ state: string; changed_at: Date }>(
    'SELECT state,changed_at FROM pg_temp.effect_admission_owner_item WHERE work_id=$1',
    [id],
  );
  return rows[0];
}

function envelopeAt(partition: number, epoch: number, position: bigint): Envelope {
  return { partition, epoch, position, events: [] };
}

function eventFor(id: string, time: string): CloudEvent {
  return {
    specversion: '1.0',
    id,
    source: 'urn:rezics:test:admission',
    type: CREATED,
    time,
    datacontenttype: 'application/json',
    sequence: '0000000000000000001',
    data: { id },
  };
}

async function waitForWorkflow(id: string): Promise<void> {
  await DBOS.retrieveWorkflow(id).getResult();
}

test.serial('owner admission commits before enqueue and checkpoint advance with no relay checkout held', async () => {
  admissionOrder.length = 0;
  const partition = freshPartition();
  const appended = await append(partition, [CREATED]);
  const id = effectWorkflowId(envelopeAt(partition, appended.epoch, appended.position), 0, 'admission_owner');
  let enqueueObserved = false;

  effects.enqueue = async (envelopes) => {
    expect(relayPool.totalCount - relayPool.idleCount).toBe(0);
    const row = await ownerItem(appended.eventIds[0]!);
    expect(row?.state).toBe('pending');
    expect(row?.changed_at.getTime()).toBe(new Date(appended.time).getTime());
    expect(await checkpoint(partition)).toBe('0');
    expect(await DBOS.getWorkflowStatus(id)).toBeFalsy();
    enqueueObserved = true;
    await enqueue(envelopes);
  };
  try {
    expect(await relayEffects(relayPool, effects, partition)).toEqual({
      status: 'read',
      envelopes: 1,
      position: appended.position,
    });
  } finally {
    effects.enqueue = enqueue;
  }

  expect(enqueueObserved).toBe(true);
  expect(await checkpoint(partition)).toBe(String(appended.position));
  await waitForWorkflow(id);
  expect((await ownerItem(appended.eventIds[0]!))?.state).toBe('processed');
});

test.serial('an admission error rolls back all rows and prevents enqueue or checkpoint movement', async () => {
  admissionOrder.length = 0;
  const partition = freshPartition();
  const first = await append(partition, [CONTEXT_CREATED]);
  const second = await append(partition, [CONTEXT_CREATED]);
  const failure = new Error('owner admission failed');
  failAdmissionId = second.eventIds[0];
  admissionFailure = failure;
  let enqueueCalls = 0;
  effects.enqueue = async (envelopes) => {
    enqueueCalls += 1;
    await enqueue(envelopes);
  };
  try {
    await expect(relayEffects(relayPool, effects, partition)).rejects.toBe(failure);
  } finally {
    effects.enqueue = enqueue;
    failAdmissionId = undefined;
    admissionFailure = undefined;
  }

  expect(enqueueCalls).toBe(0);
  expect(await ownerItem(first.eventIds[0]!)).toBeUndefined();
  expect(await ownerItem(second.eventIds[0]!)).toBeUndefined();
  expect(await checkpoint(partition)).toBe('0');
});

test.serial(
  'matching admissions follow envelope position and event sequence while effects without admit still run',
  async () => {
    admissionOrder.length = 0;
    legacyRuns.length = 0;
    const partition = freshPartition();
    const first = await append(partition, [CREATED, CREATED]);
    const second = await append(partition, [CREATED]);

    expect((await relayEffects(relayPool, effects, partition)).status).toBe('read');
    expect(admissionOrder).toEqual([...first.eventIds, ...second.eventIds]);

    const work = [...first.eventIds, ...second.eventIds];
    await Promise.all(
      work.flatMap((eventId, index) => {
        const appended = index < first.eventIds.length ? first : second;
        const eventSeq = index < first.eventIds.length ? index : index - first.eventIds.length;
        const envelope = envelopeAt(partition, appended.epoch, appended.position);
        return [
          waitForWorkflow(effectWorkflowId(envelope, eventSeq, 'admission_owner')),
          waitForWorkflow(effectWorkflowId(envelope, eventSeq, 'legacy_record')),
        ];
      }),
    );
    expect(legacyRuns).toHaveLength(work.length);
    expect(new Set(legacyRuns)).toEqual(new Set(work));
  },
);

test.serial('lost CAS and crash replay keep processed owner items and deterministic workflow identity', async () => {
  const lostCasPartition = freshPartition();
  const lostCasItem = await append(lostCasPartition, [CREATED]);
  const lostCasEnvelope = envelopeAt(lostCasPartition, lostCasItem.epoch, lostCasItem.position);
  const lostCasWorkflow = effectWorkflowId(lostCasEnvelope, 0, 'admission_owner');
  let competitorEntered = false;
  let competitorResult: Awaited<ReturnType<typeof relayEffects>> | undefined;
  effects.enqueue = async (envelopes) => {
    if (!competitorEntered) {
      competitorEntered = true;
      competitorResult = await relayEffects(relayPool, effects, lostCasPartition);
    }
    await enqueue(envelopes);
  };
  let lostCas: Awaited<ReturnType<typeof relayEffects>>;
  try {
    lostCas = await relayEffects(relayPool, effects, lostCasPartition);
  } finally {
    effects.enqueue = enqueue;
  }
  expect(competitorResult).toEqual({ status: 'read', envelopes: 1, position: lostCasItem.position });
  expect(lostCas).toEqual({ status: 'busy' });
  await waitForWorkflow(lostCasWorkflow);
  expect((await ownerItem(lostCasItem.eventIds[0]!))?.state).toBe('processed');

  const crashPartition = freshPartition();
  const crashItem = await append(crashPartition, [CREATED]);
  const crashEnvelope = envelopeAt(crashPartition, crashItem.epoch, crashItem.position);
  const stableId = effectWorkflowId(crashEnvelope, 0, 'admission_owner');
  const failure = new Error('relay stopped after workflow enqueue');
  let failOnce = true;
  effects.enqueue = async (envelopes) => {
    await enqueue(envelopes);
    if (failOnce) {
      failOnce = false;
      throw failure;
    }
  };
  try {
    await expect(relayEffects(relayPool, effects, crashPartition)).rejects.toBe(failure);
  } finally {
    effects.enqueue = enqueue;
  }
  await waitForWorkflow(stableId);
  const processedRuns = ownerRuns.get(crashItem.eventIds[0]!) ?? 0;
  expect(processedRuns).toBe(1);
  expect(await checkpoint(crashPartition)).toBe('0');

  expect(await relayEffects(relayPool, effects, crashPartition)).toEqual({
    status: 'read',
    envelopes: 1,
    position: crashItem.position,
  });
  await waitForWorkflow(stableId);
  expect(effectWorkflowId(crashEnvelope, 0, 'admission_owner')).toBe(stableId);
  expect(ownerRuns.get(crashItem.eventIds[0]!)).toBe(processedRuns);
  expect((await ownerItem(crashItem.eventIds[0]!))?.state).toBe('processed');
  expect(await checkpoint(crashPartition)).toBe(String(crashItem.position));

  const missingId = crypto.randomUUID();
  const missingTime = new Date().toISOString();
  await runOwnerItem(eventFor(missingId, missingTime));
  const restored = await ownerItem(missingId);
  expect(restored?.state).toBe('processed');
  expect(restored?.changed_at.getTime()).toBe(new Date(missingTime).getTime());
});
