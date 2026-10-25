import { afterAll, beforeAll, expect, test } from 'bun:test';
import { DBOS } from '@dbos-inc/dbos-sdk';
import pg from 'pg';
import { createPool } from '../src/database/pool.ts';
import { effectWorkflowId, launchWork, registerEffects, shutdownWork } from '../src/events/effects.ts';
import type { CloudEvent, Envelope } from '../src/events/log.ts';
import { checkGrowth, openGrowthDatabase, type GrowthDatabase } from './support/growth.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(databaseUrl);
const admin = new pg.Pool({ connectionString: databaseUrl, max: 2 });
const CREATED = 'com.rezics.subject.created.v1';
let nextPartition = 3584 + Math.floor(Math.random() * 256);
const freshPartition = () => nextPartition++;
let releaseBlocked!: () => void;
let blockedStarted!: () => void;
const blocked = new Promise<void>((resolve) => (releaseBlocked = resolve));
const started = new Promise<void>((resolve) => (blockedStarted = resolve));
const starts: string[] = [];

const effects = registerEffects([
  {
    name: 'ordered',
    types: [CREATED],
    run: async (event) => {
      starts.push(event.subject!);
      if (event.subject === 'blocked') {
        blockedStarted();
        await blocked;
      }
    },
  },
]);

beforeAll(() => launchWork({ databaseUrl }));
afterAll(async () => {
  releaseBlocked();
  await shutdownWork();
  await pool.end();
  await admin.end();
});

function event(subject: string): CloudEvent {
  return {
    specversion: '1.0',
    id: crypto.randomUUID(),
    source: 'urn:rezics:test',
    type: CREATED,
    subject,
    time: new Date().toISOString(),
    sequence: '0000000000000000001',
    datacontenttype: 'application/json',
    data: { id: subject },
  };
}
function envelope(partition: number, position: bigint, subject: string): Envelope {
  return { partition, epoch: 1, position, events: [event(subject)] };
}

async function enqueueAndWait(item: Envelope, name = 'ordered'): Promise<void> {
  await effects.enqueue([item]);
  await DBOS.retrieveWorkflow(effectWorkflowId(item, 0, name)).getResult();
}

async function seedPartitions(db: GrowthDatabase, from: number, to: number): Promise<void> {
  for (let partition = from; partition < to; partition++) {
    await db.admin.query('UPDATE core.partition SET position = position + 1 WHERE partition_no = $1', [partition]);
  }
}

test('a blocked effect in one partition does not delay effects of another partition', async () => {
  const a = freshPartition();
  const b = freshPartition();
  const first = envelope(a, 1n, 'blocked');
  const second = envelope(b, 1n, 'other-partition');
  await effects.enqueue([first]);
  await started;
  await effects.enqueue([second]);
  await DBOS.retrieveWorkflow(effectWorkflowId(second, 0, 'ordered')).getResult();
  expect(starts).toContain('other-partition');
  releaseBlocked();
  await DBOS.retrieveWorkflow(effectWorkflowId(first, 0, 'ordered')).getResult();
}, 30_000);

test('effects of one partition start in position order', async () => {
  const partition = freshPartition();
  const earlier = envelope(partition, 10n, 'position-10');
  const later = envelope(partition, 11n, 'position-11');
  await effects.enqueue([later, earlier]);
  await Promise.all(
    [earlier, later].map((item) => DBOS.retrieveWorkflow(effectWorkflowId(item, 0, 'ordered')).getResult()),
  );
  expect(starts.slice(-2)).toEqual(['position-10', 'position-11']);
}, 30_000);

test('Effect enqueue stays within its bound as N grows', async () => {
  const growth = await openGrowthDatabase(databaseUrl);
  const base = freshPartition();
  try {
    await checkGrowth(growth, {
      name: 'Effect enqueue',
      bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
      grow: async (db, scale, previous) => {
        await seedPartitions(db, base + previous, base + scale);
        for (let i = previous; i < scale; i++) {
          const item = envelope(base + i, 1n, `growth-${base + i}`);
          await enqueueAndWait(item);
        }
      },
      // Awaiting the handle keeps DBOS's background polling outside each measured capture.
      operation: async (_db, _scale, repetition) => {
        const partition = freshPartition();
        const item = envelope(partition, BigInt(repetition + 1), `measured-${partition}`);
        await enqueueAndWait(item);
      },
    });
  } finally {
    await growth.close();
  }
}, 120_000);

test('Effect persistence stays within its bound as N grows', async () => {
  const growth = await openGrowthDatabase(databaseUrl);
  try {
    await checkGrowth(growth, {
      name: 'Effect persistence',
      bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
      grow: async (db, scale, previous) => {
        await seedPartitions(db, 5000 + previous, 5000 + scale);
      },
      // The enqueue and awaited handle isolate one workflow's persisted execution and completion.
      operation: async (_db, _scale, repetition) => {
        const partition = freshPartition();
        const item = envelope(partition, BigInt(repetition + 1), `persist-${partition}`);
        await enqueueAndWait(item);
      },
    });
  } finally {
    await growth.close();
  }
}, 120_000);
