import { afterAll, beforeAll, expect, test } from 'bun:test';
import { DBOS } from '@dbos-inc/dbos-sdk';
import pg from 'pg';
import { createPool } from '../src/database/pool.ts';
import { effectWorkflowId, launchWork, registerEffects, shutdownWork } from '../src/events/effects.ts';
import type { CloudEvent, Envelope } from '../src/events/log.ts';
import { assertGrowth, capture, costOf, openGrowthDatabase, type GrowthDatabase } from './support/growth.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(databaseUrl);
const admin = new pg.Pool({ connectionString: databaseUrl, max: 2 });
const CREATED = 'com.rezics.subject.created.v1';
let nextPartition = 3584 + Math.floor(Math.random() * 256);
const freshPartition = () => nextPartition++;
let growth: GrowthDatabase;
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

beforeAll(async () => {
  growth = await openGrowthDatabase(databaseUrl);
  await launchWork({ databaseUrl, systemDatabasePool: growth.openPool({ max: 4 }) });
});
afterAll(async () => {
  releaseBlocked();
  await shutdownWork();
  await growth.close();
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

const GROWTH_SCALES = [1, 8, 64] as const;
const HISTORY_ROWS_PER_SCALE = 500;
// DBOS migrations 115_workflow_status_in_flight_index_v2 and 117_workflow_status_partition_dequeue_index_v3 index only in-flight rows.

async function seedHistory(db: GrowthDatabase, namespace: string, partitionBase: number, from: number, to: number) {
  const count = (to - from) * HISTORY_ROWS_PER_SCALE;
  if (count === 0) return;
  const offset = from * HISTORY_ROWS_PER_SCALE;
  await db.admin.query(
    `WITH history AS (
       SELECT n, $1 || ':' || n::text AS workflow_uuid,
              CASE WHEN n % 10 = 0 THEN $2::text ELSE ($2::int + n % 400)::text END AS partition_key
       FROM generate_series($3::int, $4::int - 1) AS n
     ), inserted AS (
       INSERT INTO dbos.workflow_status (
         workflow_uuid, status, name, queue_name, authenticated_user, assumed_role, authenticated_roles,
         executor_id, application_id, created_at, updated_at, recovery_attempts, inputs,
         queue_partition_key, serialization
       )
       SELECT workflow_uuid, 'SUCCESS', 'effect', 'effects', '', '', '', '', 'rezics-kernel', n, n, 0,
              '[]', partition_key, 'JSON'
       FROM history
       RETURNING workflow_uuid
     )
     INSERT INTO dbos.operation_outputs (workflow_uuid, function_id, function_name, output, error)
     SELECT workflow_uuid, 1, 'effect.run', 'null', '' FROM inserted`,
    [namespace, partitionBase, offset + 1, offset + count + 1],
  );
}

const QUEUE_POLL_PATTERNS = [
  /FROM\s+"dbos"\.workflow_status[\s\S]*queue_name[\s\S]*queue_partition_key/i,
  /WITH\s+RECURSIVE[\s\S]*FROM\s+"dbos"\.workflow_status[\s\S]*queue_partition_key/i,
];

function isQueuePoll(statement: string): boolean {
  return QUEUE_POLL_PATTERNS.some((pattern) => pattern.test(statement));
}

async function runGrowthCheck(
  db: GrowthDatabase,
  name: string,
  history: (scale: number, previous: number) => Promise<void>,
  operation: (repetition: number) => Promise<{ rows: number; blocks: number; statements: number }>,
): Promise<void> {
  let previous = 0;
  let repetition = 0;
  const samples = [];
  for (const scale of GROWTH_SCALES) {
    await history(scale, previous);
    const cost = await operation(repetition++);
    samples.push({ scale, cost });
    previous = scale;
  }
  try {
    assertGrowth(samples, { rows: 'constant', blocks: 'logarithmic', statements: 'constant' });
  } catch (error) {
    if (error instanceof Error && error.name === 'GrowthBoundError') error.message = `${name}: ${error.message}`;
    throw error;
  }
}

async function measuredPersistence(
  db: GrowthDatabase,
  item: Envelope,
): Promise<{ rows: number; blocks: number; statements: number }> {
  const result = await capture(db, () => enqueueAndWait(item));
  const statements = result.capture.statements.filter((statement) => !isQueuePoll(statement)).length;
  const plans = result.capture.plans.map((plan) => costOf({ statements: [], plans: [plan] }));
  return {
    statements,
    rows: Math.max(0, ...plans.map((cost) => cost.rows)),
    blocks: Math.max(0, ...plans.map((cost) => cost.blocks)),
  };
}

async function measuredEnqueue(item: Envelope): Promise<{ rows: number; blocks: number; statements: number }> {
  const result = await capture(growth, () => effects.enqueue([item]));
  const nonPollPlans = result.capture.plans.filter((_plan, index) => {
    const statement = result.capture.statements[index];
    return statement === undefined || !isQueuePoll(statement);
  });
  const cost = costOf({
    statements: result.capture.statements.filter((statement) => !isQueuePoll(statement)),
    plans: nonPollPlans,
  });
  await DBOS.retrieveWorkflow(effectWorkflowId(item, 0, 'ordered')).getResult();
  return { rows: cost.rows, blocks: cost.blocks, statements: cost.statements };
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
  const namespace = `effect-enqueue-history:${crypto.randomUUID()}`;
  const partitionBase = freshPartition();
  await runGrowthCheck(
    growth,
    'Effect enqueue',
    async (scale, previous) => seedHistory(growth, namespace, partitionBase, previous, scale),
    async (repetition) => {
      const partition = freshPartition();
      return measuredEnqueue(envelope(partition, BigInt(repetition + 1), `measured-enqueue-${partition}`));
    },
  );
}, 120_000);

test('Effect persistence stays within its bound as N grows', async () => {
  const namespace = `effect-persistence-history:${crypto.randomUUID()}`;
  const partitionBase = freshPartition();
  await runGrowthCheck(
    growth,
    'Effect persistence',
    async (scale, previous) => seedHistory(growth, namespace, partitionBase, previous, scale),
    async (repetition) => {
      const partition = freshPartition();
      return measuredPersistence(growth, envelope(partition, BigInt(repetition + 1), `persist-${partition}`));
    },
  );
}, 120_000);
