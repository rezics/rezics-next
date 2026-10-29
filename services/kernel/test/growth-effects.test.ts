import { afterAll, beforeAll, expect, test } from 'bun:test';
import { DBOS } from '@dbos-inc/dbos-sdk';
import pg from 'pg';
import { ERASURE_LOCATOR_EFFECTS } from '../src/access/erasure.ts';
import { createPool } from '../src/database/pool.ts';
import { effectWorkflowId, launchWork, registerEffects, shutdownWork } from '../src/events/effects.ts';
import type { CloudEvent, Envelope } from '../src/events/log.ts';
import { checkGrowth, openGrowthDatabase, type GrowthDatabase } from './support/growth.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(databaseUrl);
const admin = new pg.Pool({ connectionString: databaseUrl, max: 2 });
const CREATED = 'com.rezics.subject.created.v1';
const CONTEXT = 'com.rezics.semantic.context.created.v1';
async function within<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), 10_000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
const locator = 'growth_locator';
(ERASURE_LOCATOR_EFFECTS as Set<string>).add(locator);
let nextPartition = 3584 + Math.floor(Math.random() * 256);
const freshPartition = () => nextPartition++;
let growth: GrowthDatabase;
let releaseBlocked!: () => void;
let blockedStarted!: () => void;
const blocked = new Promise<void>((resolve) => (releaseBlocked = resolve));
const started = new Promise<void>((resolve) => (blockedStarted = resolve));
const starts: string[] = [];

const effects = registerEffects([
  { name: locator, types: [CONTEXT], async run() {} },
  {
    name: 'ordered',
    types: [CREATED],
    run: async (event) => {
      starts.push(event.subject!);
      if (event.subject === 'blocked') {
        blockedStarted();
        await within(blocked, 'blocked effect release');
      }
    },
  },
]);

beforeAll(async () => {
  growth = await openGrowthDatabase(databaseUrl);
  await within(launchWork({ databaseUrl, systemDatabasePool: growth.openPool({ max: 4 }) }), 'executor launch');
});
afterAll(async () => {
  releaseBlocked();
  await within(shutdownWork(), 'executor shutdown');
  (ERASURE_LOCATOR_EFFECTS as Set<string>).delete(locator);
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
  await within(DBOS.retrieveWorkflow(effectWorkflowId(item, 0, name)).getResult(), 'effect result');
}

const GROWTH_SCALES = [256, 1024, 4096] as const;
// Start every DBOS history relation at thousands of rows so point lookups use their indexes.
const HISTORY_ROWS_PER_SCALE = 16;
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
     ), inputs AS (
       INSERT INTO dbos.workflow_input (workflow_uuid, inputs)
       SELECT workflow_uuid, '[]' FROM inserted
     ), outputs AS (
       INSERT INTO dbos.workflow_output (workflow_uuid, output, error)
       SELECT workflow_uuid, 'null', '' FROM inserted
     )
     INSERT INTO dbos.operation_outputs (workflow_uuid, function_id, function_name, output, error)
     SELECT workflow_uuid, 1, 'effect.run', 'null', '' FROM inserted`,
    [namespace, partitionBase, offset + 1, offset + count + 1],
  );
}

test('a blocked effect in one partition does not delay effects of another partition', async () => {
  const a = freshPartition();
  const b = freshPartition();
  const first = envelope(a, 1n, 'blocked');
  const second = envelope(b, 1n, 'other-partition');
  await effects.enqueue([first]);
  await within(started, 'blocked effect start');
  await effects.enqueue([second]);
  await within(DBOS.retrieveWorkflow(effectWorkflowId(second, 0, 'ordered')).getResult(), 'other partition result');
  expect(starts).toContain('other-partition');
  releaseBlocked();
  await within(DBOS.retrieveWorkflow(effectWorkflowId(first, 0, 'ordered')).getResult(), 'released effect result');
}, 60_000);

test('effects of one partition start in position order', async () => {
  const partition = freshPartition();
  const earlier = envelope(partition, 10n, 'position-10');
  const later = envelope(partition, 11n, 'position-11');
  await effects.enqueue([later, earlier]);
  await within(
    Promise.all([earlier, later].map((item) => DBOS.retrieveWorkflow(effectWorkflowId(item, 0, 'ordered')).getResult())),
    'ordered effect results',
  );
  expect(starts.slice(-2)).toEqual(['position-10', 'position-11']);
}, 30_000);

test('Effect enqueue stays within its bound as N grows', async () => {
  const namespace = `effect-enqueue-history:${crypto.randomUUID()}`;
  const partitionBase = freshPartition();
  const report = await checkGrowth(growth, {
    name: 'Effect enqueue',
    scales: GROWTH_SCALES,
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    grow: (db, scale, previous) => seedHistory(db, namespace, partitionBase, previous, scale),
    operation: async (_db, _scale, repetition) => {
      const partition = freshPartition();
      await effects.enqueue([envelope(partition, BigInt(repetition + 1), `measured-enqueue-${partition}`)]);
    },
  });
  console.log(
    report.name,
    JSON.stringify(
      report.samples.map(({ scale, cost }) => ({
        scale,
        rows: cost.rows,
        blocks: cost.blocks,
        statements: cost.statements,
        backgroundStatements: cost.backgroundStatements,
      })),
    ),
  );
}, 120_000);

test('Effect persistence stays within its bound as N grows', async () => {
  const namespace = `effect-persistence-history:${crypto.randomUUID()}`;
  const partitionBase = freshPartition();
  const report = await checkGrowth(growth, {
    name: 'Effect persistence',
    scales: GROWTH_SCALES,
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    grow: (db, scale, previous) => seedHistory(db, namespace, partitionBase, previous, scale),
    operation: async (_db, _scale, repetition) => {
      const partition = freshPartition();
      await enqueueAndWait(envelope(partition, BigInt(repetition + 1), `persist-${partition}`));
    },
  });
  console.log(
    report.name,
    JSON.stringify(
      report.samples.map(({ scale, cost }) => ({
        scale,
        rows: cost.rows,
        blocks: cost.blocks,
        statements: cost.statements,
        backgroundStatements: cost.backgroundStatements,
      })),
    ),
  );
}, 300_000);

test(`locator success adds one batch insert and stays bounded as kept rows and DBOS history grow`, async () => {
  const namespace = `locator-growth:success:${crypto.randomUUID()}`;
  const partitionBase = freshPartition();
  const report = await checkGrowth(growth, {
    name: `Locator effect success`,
    scales: GROWTH_SCALES,
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    async grow(db, scale, previous) {
      await seedHistory(db, namespace, partitionBase, previous, scale);
      await db.admin.query(
        `INSERT INTO access.erasure_locator_work(workflow_id,effect,opened_at,state)
           SELECT $1||':'||n,'growth_locator',0,'done'
           FROM generate_series($2::integer+1,$3::integer) n`,
        [namespace, previous, scale],
      );
    },
    async operation(_db, _scale, repetition) {
      const partition = freshPartition();
      const batch = [1n, 2n].map((position) => {
        const item = envelope(partition, position, `locator-${partition}-${repetition}-${position}`);
        item.events[0]!.type = CONTEXT;
        return item;
      });
      await effects.enqueue(batch);
      for (const item of batch)
        await within(DBOS.retrieveWorkflow(effectWorkflowId(item, 0, locator)).getResult(), 'locator success');
    },
  });
  expect(new Set(report.samples.map(({ cost }) => cost.statements)).size).toBe(1);
  expect(new Set(report.samples.map(({ cost }) => cost.rows)).size).toBe(1);
  for (const sample of report.samples) {
    for (const statements of sample.statementRepetitions) {
      const inserts = statements.filter(({ statement }) =>
        statement.startsWith('INSERT INTO access.erasure_locator_work'),
      );
      expect(inserts).toHaveLength(1);
      expect(inserts[0]!.count).toBe(1);
      {
        const updates = statements.filter(({ statement }) =>
          statement.startsWith('UPDATE access.erasure_locator_work'),
        );
        expect(updates).toHaveLength(1);
        expect(updates[0]!.count).toBe(2);
      }
    }
    expect(sample.cost.relations['access.erasure_locator_work']?.sequentialScans ?? 0).toBe(0);
  }
}, 600000);
